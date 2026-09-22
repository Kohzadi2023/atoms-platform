export type OliviaAssistedActionKind = "PREPARE_MEETING_BRIEF";

export type OliviaAssistedActionStatus =
  | "PENDING"
  | "PROMPT_COPIED"
  | "RESPONSE_RECEIVED"
  | "VALIDATED"
  | "COMPLETED";

export type OliviaAssistedActionImportance = "BLOCKING" | "REQUIRED" | "OPTIONAL";

export type MeetingPreparationState =
  | "OLIVIA_ACTION_REQUIRED"
  | "READY_FOR_AGENT_PREPARATION";

export interface MeetingBriefContext {
  readonly title: string;
  readonly objective: string;
  readonly expectedOutcome: string;
  readonly decisionQuestion: string;
  readonly relevantProjectContext?: string;
  readonly knownOpenItems?: readonly string[];
}

export interface OliviaAssistedAction {
  readonly kind: OliviaAssistedActionKind;
  readonly title: string;
  readonly reason: string;
  readonly importance: OliviaAssistedActionImportance;
  readonly targetField: "meetingBrief";
  readonly prompt: string;
  readonly status: OliviaAssistedActionStatus;
}

export interface MeetingBriefValidationResult {
  readonly valid: boolean;
  readonly normalizedResponse?: string;
  readonly missingSections: readonly string[];
  readonly violations: readonly string[];
}

export interface MeetingBriefCompletionResult {
  readonly validation: MeetingBriefValidationResult;
  readonly meetingBrief?: string;
  readonly actionStatus: OliviaAssistedActionStatus;
  readonly meetingState: MeetingPreparationState;
}

const REQUIRED_SECTIONS = [
  "Current State",
  "Decision Required",
  "Relevant Facts",
  "Known Constraints",
  "Open Questions / Gates",
  "Meeting Goal",
  "Exit Criteria",
] as const;

const MINIMUM_BRIEF_LENGTH = 180;

export function buildMeetingBriefPrompt(context: MeetingBriefContext): string {
  const projectContext = normalizeOptional(context.relevantProjectContext) ?? "Not supplied.";
  const openItems =
    context.knownOpenItems === undefined || context.knownOpenItems.length === 0
      ? "Not supplied."
      : context.knownOpenItems.map((item) => `- ${item.trim()}`).join("\n");

  return [
    "You are preparing a Meeting Brief for a structured AI-assisted decision meeting.",
    "",
    "Using only the supplied context, create a concise factual brief that prepares the participants for the meeting.",
    "Do not invent facts. Clearly distinguish known facts from unresolved assumptions.",
    "Keep the output concise and decision-oriented.",
    "",
    `Meeting: ${context.title.trim()}`,
    "",
    "Objective:",
    context.objective.trim(),
    "",
    "Expected Outcome:",
    context.expectedOutcome.trim(),
    "",
    "Decision Question:",
    context.decisionQuestion.trim(),
    "",
    "Relevant Project Context:",
    projectContext,
    "",
    "Known Open Items:",
    openItems,
    "",
    "Required output:",
    "",
    "Meeting Brief",
    "",
    "1. Current State",
    "2. Decision Required",
    "3. Relevant Facts",
    "4. Known Constraints",
    "5. Open Questions / Gates",
    "6. Meeting Goal",
    "7. Exit Criteria",
  ].join("\n");
}

export function createMeetingBriefAction(
  context: MeetingBriefContext,
  status: OliviaAssistedActionStatus = "PENDING",
): OliviaAssistedAction {
  return {
    kind: "PREPARE_MEETING_BRIEF",
    title: "Prepare Meeting Brief",
    reason:
      "This meeting cannot advance to agent preparation until Olivia supplies a validated Meeting Brief.",
    importance: "BLOCKING",
    targetField: "meetingBrief",
    prompt: buildMeetingBriefPrompt(context),
    status,
  };
}

export function validateMeetingBriefResponse(
  response: string,
): MeetingBriefValidationResult {
  const normalizedResponse = response.trim();
  const searchable = normalizeForSectionSearch(normalizedResponse);
  const missingSections = REQUIRED_SECTIONS.filter(
    (section) => !hasRequiredSection(searchable, section),
  );
  const violations: string[] = [];

  if (normalizedResponse.length === 0) {
    violations.push("Paste the AI response before validating it.");
  } else if (normalizedResponse.length < MINIMUM_BRIEF_LENGTH) {
    violations.push(
      `Meeting Brief is too short to be decision-ready (minimum ${String(MINIMUM_BRIEF_LENGTH)} characters).`,
    );
  }

  if (missingSections.length > 0) {
    violations.push("The response is missing one or more required Meeting Brief sections.");
  }

  if (violations.length > 0) {
    return {
      valid: false,
      missingSections,
      violations,
    };
  }

  return {
    valid: true,
    normalizedResponse,
    missingSections: [],
    violations: [],
  };
}

export function completeMeetingBriefAction(
  response: string,
): MeetingBriefCompletionResult {
  const validation = validateMeetingBriefResponse(response);

  if (!validation.valid || validation.normalizedResponse === undefined) {
    return {
      validation,
      actionStatus: response.trim().length === 0 ? "PENDING" : "RESPONSE_RECEIVED",
      meetingState: "OLIVIA_ACTION_REQUIRED",
    };
  }

  return {
    validation,
    meetingBrief: validation.normalizedResponse,
    actionStatus: "COMPLETED",
    meetingState: "READY_FOR_AGENT_PREPARATION",
  };
}

export function resolveMeetingPreparationState(
  meetingBrief: string | undefined,
  actionStatus: OliviaAssistedActionStatus,
): MeetingPreparationState {
  if (actionStatus !== "COMPLETED") return "OLIVIA_ACTION_REQUIRED";
  if (meetingBrief === undefined || meetingBrief.trim().length === 0) {
    return "OLIVIA_ACTION_REQUIRED";
  }
  return "READY_FOR_AGENT_PREPARATION";
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeForSectionSearch(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("&", "and")
    .replace(/[^a-z0-9\s/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasRequiredSection(searchable: string, section: (typeof REQUIRED_SECTIONS)[number]): boolean {
  switch (section) {
    case "Open Questions / Gates":
      return (
        searchable.includes("open questions") ||
        searchable.includes("open gates") ||
        searchable.includes("open questions / gates")
      );
    default:
      return searchable.includes(section.toLowerCase());
  }
}

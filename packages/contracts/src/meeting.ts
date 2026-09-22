import { z } from "zod";

export const MeetingPreparationStateSchema = z.enum([
  "OLIVIA_ACTION_REQUIRED",
  "READY_FOR_AGENT_PREPARATION",
]);
export type MeetingPreparationState = z.infer<typeof MeetingPreparationStateSchema>;

export const OliviaAssistedActionKindSchema = z.enum(["PREPARE_MEETING_BRIEF"]);
export type OliviaAssistedActionKind = z.infer<typeof OliviaAssistedActionKindSchema>;

export const OliviaAssistedActionStatusSchema = z.enum([
  "PENDING",
  "PROMPT_COPIED",
  "RESPONSE_RECEIVED",
  "VALIDATED",
  "COMPLETED",
]);
export type OliviaAssistedActionStatus = z.infer<typeof OliviaAssistedActionStatusSchema>;

export interface MeetingBriefContext {
  readonly title: string;
  readonly objective: string;
  readonly expectedOutcome: string;
  readonly decisionQuestion: string;
  readonly relevantProjectContext?: string;
  readonly knownOpenItems?: readonly string[];
}

export interface MeetingBriefValidationResult {
  readonly valid: boolean;
  readonly normalizedResponse?: string;
  readonly missingSections: readonly string[];
  readonly violations: readonly string[];
}

const REQUIRED_MEETING_BRIEF_SECTIONS = [
  "Current State",
  "Decision Required",
  "Relevant Facts",
  "Known Constraints",
  "Open Questions / Gates",
  "Meeting Goal",
  "Exit Criteria",
] as const;

const MINIMUM_MEETING_BRIEF_LENGTH = 180;

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

export function validateMeetingBriefResponse(response: string): MeetingBriefValidationResult {
  const normalizedResponse = response.trim();
  const searchable = normalizeForSectionSearch(normalizedResponse);
  const missingSections = REQUIRED_MEETING_BRIEF_SECTIONS.filter(
    (section) => !hasRequiredSection(searchable, section),
  );
  const violations: string[] = [];

  if (normalizedResponse.length === 0) {
    violations.push("Paste the AI response before validating it.");
  } else if (normalizedResponse.length < MINIMUM_MEETING_BRIEF_LENGTH) {
    violations.push(
      `Meeting Brief is too short to be decision-ready (minimum ${String(MINIMUM_MEETING_BRIEF_LENGTH)} characters).`,
    );
  }

  if (missingSections.length > 0) {
    violations.push("The response is missing one or more required Meeting Brief sections.");
  }

  if (violations.length > 0) {
    return { valid: false, missingSections, violations };
  }

  return {
    valid: true,
    normalizedResponse,
    missingSections: [],
    violations: [],
  };
}

export const CreateMeetingInputSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(200),
    objective: z.string().trim().min(1).max(8_000),
    expectedOutcome: z.string().trim().min(1).max(8_000),
    decisionQuestion: z.string().trim().min(1).max(8_000),
    relevantProjectContext: z.string().trim().min(1).max(20_000).optional(),
    knownOpenItems: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  })
  .strict();
export type CreateMeetingInput = z.infer<typeof CreateMeetingInputSchema>;

export const CompleteMeetingBriefActionInputSchema = z
  .object({ response: z.string().trim().min(1).max(100_000) })
  .strict();
export type CompleteMeetingBriefActionInput = z.infer<
  typeof CompleteMeetingBriefActionInputSchema
>;

export const OliviaAssistedActionResponseSchema = z
  .object({
    id: z.string().uuid(),
    meetingId: z.string().uuid(),
    kind: OliviaAssistedActionKindSchema,
    status: OliviaAssistedActionStatusSchema,
    targetField: z.literal("meetingBrief"),
    prompt: z.string().min(1),
    response: z.string().nullable(),
    completedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type OliviaAssistedActionResponse = z.infer<
  typeof OliviaAssistedActionResponseSchema
>;

export const MeetingResponseSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    projectId: z.string().uuid().nullable(),
    title: z.string(),
    objective: z.string(),
    expectedOutcome: z.string(),
    decisionQuestion: z.string(),
    relevantProjectContext: z.string().nullable(),
    knownOpenItems: z.array(z.string()),
    meetingBrief: z.string().nullable(),
    preparationState: MeetingPreparationStateSchema,
    oliviaAction: OliviaAssistedActionResponseSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type MeetingResponse = z.infer<typeof MeetingResponseSchema>;

export const MeetingListResponseSchema = z
  .object({ items: z.array(MeetingResponseSchema) })
  .strict();
export type MeetingListResponse = z.infer<typeof MeetingListResponseSchema>;

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

function hasRequiredSection(
  searchable: string,
  section: (typeof REQUIRED_MEETING_BRIEF_SECTIONS)[number],
): boolean {
  if (section === "Open Questions / Gates") {
    return searchable.includes("open questions") || searchable.includes("open gates");
  }
  return searchable.includes(section.toLowerCase());
}

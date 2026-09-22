import {
  buildMeetingBriefPrompt,
  validateMeetingBriefResponse,
  type MeetingBriefContext,
  type MeetingBriefValidationResult,
  type MeetingPreparationState,
  type OliviaAssistedActionKind,
  type OliviaAssistedActionStatus,
} from "@atoms/contracts";

export {
  buildMeetingBriefPrompt,
  validateMeetingBriefResponse,
};
export type {
  MeetingBriefContext,
  MeetingBriefValidationResult,
  MeetingPreparationState,
  OliviaAssistedActionKind,
  OliviaAssistedActionStatus,
};

export type OliviaAssistedActionImportance = "BLOCKING" | "REQUIRED" | "OPTIONAL";

export interface OliviaAssistedAction {
  readonly kind: OliviaAssistedActionKind;
  readonly title: string;
  readonly reason: string;
  readonly importance: OliviaAssistedActionImportance;
  readonly targetField: "meetingBrief";
  readonly prompt: string;
  readonly status: OliviaAssistedActionStatus;
}

export interface MeetingBriefCompletionResult {
  readonly validation: MeetingBriefValidationResult;
  readonly meetingBrief?: string;
  readonly actionStatus: OliviaAssistedActionStatus;
  readonly meetingState: MeetingPreparationState;
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

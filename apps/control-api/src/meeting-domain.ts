import {
  MeetingPreparationStateSchema,
  OliviaAssistedActionKindSchema,
  OliviaAssistedActionStatusSchema,
  type MeetingPreparationState,
  type MeetingResponse,
  type OliviaAssistedActionKind,
  type OliviaAssistedActionStatus,
} from "@atoms/contracts";

export interface OliviaAssistedActionRecord {
  readonly id: string;
  readonly meetingId: string;
  readonly kind: OliviaAssistedActionKind;
  readonly status: OliviaAssistedActionStatus;
  readonly targetField: string;
  readonly prompt: string;
  readonly response: string | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MeetingRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly objective: string;
  readonly expectedOutcome: string;
  readonly decisionQuestion: string;
  readonly relevantProjectContext: string | null;
  readonly knownOpenItems: readonly string[];
  readonly meetingBrief: string | null;
  readonly preparationState: MeetingPreparationState;
  readonly oliviaAction: OliviaAssistedActionRecord;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toMeetingResponse(record: MeetingRecord): MeetingResponse {
  if (record.oliviaAction.targetField !== "meetingBrief") {
    throw new Error(`Unsupported Olivia target field: ${record.oliviaAction.targetField}`);
  }

  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    title: record.title,
    objective: record.objective,
    expectedOutcome: record.expectedOutcome,
    decisionQuestion: record.decisionQuestion,
    relevantProjectContext: record.relevantProjectContext,
    knownOpenItems: [...record.knownOpenItems],
    meetingBrief: record.meetingBrief,
    preparationState: MeetingPreparationStateSchema.parse(record.preparationState),
    oliviaAction: {
      id: record.oliviaAction.id,
      meetingId: record.oliviaAction.meetingId,
      kind: OliviaAssistedActionKindSchema.parse(record.oliviaAction.kind),
      status: OliviaAssistedActionStatusSchema.parse(record.oliviaAction.status),
      targetField: "meetingBrief",
      prompt: record.oliviaAction.prompt,
      response: record.oliviaAction.response,
      completedAt: record.oliviaAction.completedAt?.toISOString() ?? null,
      createdAt: record.oliviaAction.createdAt.toISOString(),
      updatedAt: record.oliviaAction.updatedAt.toISOString(),
    },
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

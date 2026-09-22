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
  .object({
    response: z.string().trim().min(1).max(100_000),
  })
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

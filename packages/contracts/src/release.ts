import { z } from "zod";

import { JsonValueSchema } from "./json.js";

const IsoTimestampSchema = z.string().datetime({ offset: true });

export const ReleaseAssessmentStatusSchema = z.enum(["READY", "BLOCKED"]);
export type ReleaseAssessmentStatus = z.infer<
  typeof ReleaseAssessmentStatusSchema
>;

/**
 * The route never accepts evidence, criteria, or an attempt number in the
 * request body. Triggering an assessment always re-gathers evidence from
 * trusted, durable records server-side (see the orchestrator-worker's
 * ReleaseAssessmentRepository) -- accepting any of that from a client would
 * let a caller assert a check ran without it ever having run.
 */
export const TriggerReleaseAssessmentInputSchema = z.object({}).strict();
export type TriggerReleaseAssessmentInput = z.infer<
  typeof TriggerReleaseAssessmentInputSchema
>;

export const ReleaseAssessmentResponseSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    projectId: z.string().uuid(),
    runId: z.string().uuid(),
    controlVersion: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: ReleaseAssessmentStatusSchema,
    mode: z.literal("OBSERVE_ONLY"),
    acceptanceTaskId: z.string().uuid().nullable(),
    policy: JsonValueSchema,
    checks: JsonValueSchema,
    traceToAcceptance: JsonValueSchema,
    issues: JsonValueSchema,
    evaluatedAt: IsoTimestampSchema,
    createdAt: IsoTimestampSchema,
  })
  .strict();

export type ReleaseAssessmentResponse = z.infer<
  typeof ReleaseAssessmentResponseSchema
>;

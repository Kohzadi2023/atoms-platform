import { z } from "zod";

import { JsonValueSchema } from "./json.js";

export const RunEventTypeSchema = z.enum([
  "run.created",
  "run.status_changed",
  "task.created",
  "task.started",
  "task.progress",
  "task.completed",
  "task.failed",
  // A premium agent's ordinal that the entitlement gate bypassed --
  // apps/orchestrator-worker/src/graph.ts. Generic JsonValue payload, same
  // as its task.* siblings.
  "task.skipped",
  "artifact.created",
  "approval.required",
  "sandbox.ready",
  "preview.updated",
  "integration.status_changed",
  "deployment.status_changed",
  "run.completed",
  "run.failed",
  // Observe-only QA & Release assessment events (PR #70). Additive: the
  // evaluator (@atoms/quality) never blocks run completion or deployment.
  "release.assessment_started",
  "release.ready",
  "release.blocked",
  // G2 (docs/adr/production-execution-gate.md), issue #100. Neither ever
  // blocks or retries the run; both are additive lifecycle markers on a
  // PAUSED or already-CANCELLED run.
  "run.approval_reminder_due",
  "run.data_purged",
  // Compatibility aliases retained for the already-shipped Checkpoint 2 API.
  "task_started",
  "code_generated",
  "approval_required",
  "error",
]);

export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const RunAgentNameSchema = z.enum([
  "Sophia",
  "Mike",
  "Emma",
  "Bob",
  "Alex",
  "David",
  "Sarah",
  "Adrian",
  "CustomerSuccess",
]);

export type RunAgentName = z.infer<typeof RunAgentNameSchema>;

export const ArtifactTypeSchema = z.enum([
  "sophia-output",
  "mike-output",
  "emma-output",
  "bob-output",
  "alex-output",
  "david-output",
  "sarah-output",
  "adrian-output",
  "customersuccess-output",
  "seo-package",
  "content-package",
]);

export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactCreatedEventPayloadV1Schema = z
  .object({
    version: z.literal("v1"),
    taskId: z.string().uuid(),
    agent: RunAgentNameSchema,
    artifactType: ArtifactTypeSchema,
    migrationArtifactId: z.string().uuid().optional(),
  })
  .strict();

export type ArtifactCreatedEventPayloadV1 = z.infer<
  typeof ArtifactCreatedEventPayloadV1Schema
>;

export const ApprovalRequiredEventPayloadV1Schema = z
  .object({
    version: z.literal("v1"),
    scope: z.enum(["plan", "content"]),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type ApprovalRequiredEventPayloadV1 = z.infer<
  typeof ApprovalRequiredEventPayloadV1Schema
>;

const LegacyArtifactCreatedEventPayloadSchema =
  ArtifactCreatedEventPayloadV1Schema.omit({ version: true }).strict();

const LegacyApprovalRequiredEventPayloadSchema = z
  .object({
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export function normalizeArtifactCreatedEventPayload(
  payload: unknown,
): ArtifactCreatedEventPayloadV1 {
  const current = ArtifactCreatedEventPayloadV1Schema.safeParse(payload);
  if (current.success) return current.data;

  const legacy = LegacyArtifactCreatedEventPayloadSchema.parse(payload);
  return ArtifactCreatedEventPayloadV1Schema.parse({
    version: "v1",
    ...legacy,
  });
}

export function normalizeApprovalRequiredEventPayload(
  payload: unknown,
): ApprovalRequiredEventPayloadV1 {
  const current = ApprovalRequiredEventPayloadV1Schema.safeParse(payload);
  if (current.success) return current.data;

  const legacy = LegacyApprovalRequiredEventPayloadSchema.parse(payload);
  return {
    version: "v1",
    scope: legacy.reason.toLowerCase().includes("content")
      ? "content"
      : "plan",
    reason: legacy.reason,
  };
}

export const SandboxReadyEventPayloadV1Schema = z
  .object({
    version: z.literal("v1"),
    sandboxSessionId: z.string().uuid(),
    status: z.literal("VALIDATING"),
  })
  .strict();

export type SandboxReadyEventPayloadV1 = z.infer<
  typeof SandboxReadyEventPayloadV1Schema
>;

export const SandboxValidationProgressEventPayloadV1Schema = z
  .object({
    version: z.literal("v1"),
    phase: z.literal("sandbox-validation"),
    sandboxSessionId: z.string().uuid(),
    ordinal: z.number().int().positive(),
    step: z.enum([
      "install",
      "prisma-validate",
      "lint",
      "typecheck",
      "test",
      "build",
      "preview-start",
      "preview-health",
      // G3 (docs/adr/production-execution-gate.md), added with #129/#133: a
      // task.progress event is appended for every ValidationStepReport the
      // sandbox runner produces, so a step name missing here throws inside
      // the same DB transaction that records it -- silently defeating the
      // "never blocks the run" design of these four steps.
      "db-start",
      "db-migrate",
      "db-seed",
      "acceptance",
    ]),
    status: z.enum(["SUCCEEDED", "FAILED"]),
    exitCode: z.number().int(),
    durationMs: z.number().int().nonnegative(),
    stdout: z.string().max(64_012),
    stderr: z.string().max(64_012),
  })
  .strict();

export type SandboxValidationProgressEventPayloadV1 = z.infer<
  typeof SandboxValidationProgressEventPayloadV1Schema
>;

export const PreviewUpdatedEventPayloadV1Schema = z
  .object({
    version: z.literal("v1"),
    previewSessionId: z.string().uuid(),
    status: z.enum(["READY", "STOPPED", "EXPIRED", "ERROR"]),
    url: z.string().url().optional(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type PreviewUpdatedEventPayloadV1 = z.infer<
  typeof PreviewUpdatedEventPayloadV1Schema
>;

export const DatabaseStatusChangedEventPayloadV1Schema = z
  .object({
    version: z.literal("v1"),
    integration: z.literal("generated-database"),
    databaseInstanceId: z.string().uuid(),
    operationId: z.string().uuid(),
    operationVersion: z.number().int().nonnegative(),
    provider: z.literal("SUPABASE"),
    status: z.enum([
      "QUEUED",
      "PROVISIONING",
      "HEALTH_CHECK",
      "MIGRATING",
      "READY",
      "SUSPENDED",
      "FAILED",
      "DELETING",
      "DELETED",
    ]),
    message: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export type DatabaseStatusChangedEventPayloadV1 = z.infer<
  typeof DatabaseStatusChangedEventPayloadV1Schema
>;

export const ReleaseAssessmentStartedEventPayloadV1Schema = z
  .object({
    version: z.literal("v1"),
    assessmentId: z.string().uuid(),
    attempt: z.number().int().positive(),
  })
  .strict();

export type ReleaseAssessmentStartedEventPayloadV1 = z.infer<
  typeof ReleaseAssessmentStartedEventPayloadV1Schema
>;

export const ReleaseReadyEventPayloadV1Schema = z
  .object({
    version: z.literal("v1"),
    assessmentId: z.string().uuid(),
    status: z.literal("READY"),
    checkCount: z.number().int().nonnegative(),
    criterionCount: z.number().int().nonnegative(),
  })
  .strict();

export type ReleaseReadyEventPayloadV1 = z.infer<
  typeof ReleaseReadyEventPayloadV1Schema
>;

export const ReleaseBlockedEventPayloadV1Schema = z
  .object({
    version: z.literal("v1"),
    assessmentId: z.string().uuid(),
    status: z.literal("BLOCKED"),
    issueCount: z.number().int().positive(),
  })
  .strict();

export type ReleaseBlockedEventPayloadV1 = z.infer<
  typeof ReleaseBlockedEventPayloadV1Schema
>;

// G2: no delivery channel exists yet (no email/webhook integration anywhere
// in this platform) -- this event is the full extent of "reminder" today. A
// future notifier can watch for it; nothing here sends anything.
export const ApprovalReminderDueEventPayloadV1Schema = z
  .object({
    version: z.literal("v1"),
    pausedAt: z.string().datetime({ offset: true }),
    approvalExpiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type ApprovalReminderDueEventPayloadV1 = z.infer<
  typeof ApprovalReminderDueEventPayloadV1Schema
>;

// G2 / design-partner-runbook.md retention clause. Redacts the run's prompt,
// checkpoint and task input/output, and drops its attachment links; the
// run's own event log (this one included) is left intact as an audit trail.
export const RunDataPurgedEventPayloadV1Schema = z
  .object({
    version: z.literal("v1"),
    reason: z.literal("APPROVAL_EXPIRED"),
    cancelledAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type RunDataPurgedEventPayloadV1 = z.infer<
  typeof RunDataPurgedEventPayloadV1Schema
>;

export function validateRunEventPayload(
  eventType: RunEventType,
  payload: unknown,
) {
  if (eventType === "sandbox.ready") {
    return SandboxReadyEventPayloadV1Schema.parse(payload);
  }
  if (eventType === "task.progress") {
    return SandboxValidationProgressEventPayloadV1Schema.parse(payload);
  }
  if (eventType === "preview.updated") {
    return PreviewUpdatedEventPayloadV1Schema.parse(payload);
  }
  if (eventType === "integration.status_changed") {
    return DatabaseStatusChangedEventPayloadV1Schema.parse(payload);
  }
  if (eventType === "artifact.created") {
    return normalizeArtifactCreatedEventPayload(payload);
  }
  if (
    eventType === "approval.required" ||
    eventType === "approval_required"
  ) {
    return normalizeApprovalRequiredEventPayload(payload);
  }
  if (eventType === "release.assessment_started") {
    return ReleaseAssessmentStartedEventPayloadV1Schema.parse(payload);
  }
  if (eventType === "release.ready") {
    return ReleaseReadyEventPayloadV1Schema.parse(payload);
  }
  if (eventType === "release.blocked") {
    return ReleaseBlockedEventPayloadV1Schema.parse(payload);
  }
  if (eventType === "run.approval_reminder_due") {
    return ApprovalReminderDueEventPayloadV1Schema.parse(payload);
  }
  if (eventType === "run.data_purged") {
    return RunDataPurgedEventPayloadV1Schema.parse(payload);
  }
  return JsonValueSchema.parse(payload);
}

export const RunEventEnvelopeSchema = z
  .object({
    sequence: z.number().int().positive(),
    runId: z.string().uuid(),
    eventType: RunEventTypeSchema,
    payload: JsonValueSchema,
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type RunEventEnvelope = z.infer<typeof RunEventEnvelopeSchema>;

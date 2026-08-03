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
  "artifact.created",
  "approval.required",
  "sandbox.ready",
  "preview.updated",
  "integration.status_changed",
  "deployment.status_changed",
  "run.completed",
  "run.failed",
  // Compatibility aliases retained for the already-shipped Checkpoint 2 API.
  "task_started",
  "code_generated",
  "approval_required",
  "error",
]);

export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const ArtifactTypeSchema = z.enum([
  "mike-output",
  "emma-output",
  "bob-output",
  "alex-output",
  "david-output",
  "sarah-output",
  "adrian-output",
  "seo-package",
  "content-package",
]);

export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactCreatedEventPayloadV1Schema = z
  .object({
    version: z.literal("v1"),
    taskId: z.string().uuid(),
    agent: z.enum(["Mike", "Emma", "Bob", "Alex", "David", "Sarah", "Adrian"]),
    artifactType: ArtifactTypeSchema,
    migrationArtifactId: z.string().uuid().optional(),
  })
  .strict();

export type ArtifactCreatedEventPayloadV1 = z.infer<
  typeof ArtifactCreatedEventPayloadV1Schema
>;

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
    return ArtifactCreatedEventPayloadV1Schema.parse(payload);
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

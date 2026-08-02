import { z } from "zod";

import { JsonValueSchema } from "./json.js";

const IsoTimestampSchema = z.string().datetime({ offset: true });

export const GeneratedDatabaseProviderSchema = z.enum(["SUPABASE"]);
export type GeneratedDatabaseProvider = z.infer<
  typeof GeneratedDatabaseProviderSchema
>;

export const DatabaseInstanceStatusSchema = z.enum([
  "QUEUED",
  "PROVISIONING",
  "HEALTH_CHECK",
  "MIGRATING",
  "READY",
  "SUSPENDED",
  "FAILED",
  "DELETING",
  "DELETED",
]);
export type DatabaseInstanceStatus = z.infer<
  typeof DatabaseInstanceStatusSchema
>;

export const ProvisionDatabaseInputSchema = z
  .object({
    provider: z.literal("SUPABASE"),
    region: z.enum(["americas", "emea", "apac"]),
    migrationArtifactId: z.string().uuid(),
    approveDestructiveChanges: z.boolean().default(false),
    confirmation: z.literal("PROVISION_DATABASE"),
  })
  .strict();

export type ProvisionDatabaseInput = z.infer<
  typeof ProvisionDatabaseInputSchema
>;

export const DatabaseActionInputSchema = z
  .object({
    action: z.literal("destroy"),
    confirmation: z.literal("DESTROY_DATABASE"),
  })
  .strict();

export type DatabaseActionInput = z.infer<typeof DatabaseActionInputSchema>;

export const DatabaseInstanceResponseSchema = z
  .object({
    id: z.string().uuid(),
    operationId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    projectId: z.string().uuid(),
    migrationArtifactId: z.string().uuid(),
    provider: GeneratedDatabaseProviderSchema,
    externalId: z.string().nullable(),
    displayName: z.string(),
    databaseName: z.string().nullable(),
    region: z.string(),
    status: DatabaseInstanceStatusSchema,
    attempt: z.number().int().nonnegative(),
    error: JsonValueSchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    readyAt: IsoTimestampSchema.nullable(),
    deletedAt: IsoTimestampSchema.nullable(),
  })
  .strict();

export type DatabaseInstanceResponse = z.infer<
  typeof DatabaseInstanceResponseSchema
>;

export const MigrationArtifactResponseSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    projectId: z.string().uuid(),
    sourceRunId: z.string().uuid(),
    schemaPath: z.string().min(1).max(1_024),
    schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
    migrationPaths: z.array(z.string().min(1).max(1_024)).min(1).max(50),
    seedPath: z.string().min(1).max(1_024),
    destructive: z.boolean(),
    policyReport: JsonValueSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();

export type MigrationArtifactResponse = z.infer<
  typeof MigrationArtifactResponseSchema
>;

export const DatabaseOperationCommandSchema = z.enum([
  "provision",
  "destroy",
]);
export type DatabaseOperationCommand = z.infer<
  typeof DatabaseOperationCommandSchema
>;

export const DatabaseOperationJobSchema = z
  .object({
    operationId: z.string().uuid(),
    databaseInstanceId: z.string().uuid(),
    command: DatabaseOperationCommandSchema,
    operationVersion: z.number().int().nonnegative().default(0),
  })
  .strict();

export type DatabaseOperationJob = z.infer<
  typeof DatabaseOperationJobSchema
>;

export const DATABASE_OPERATION_QUEUE_NAME = "database-operations" as const;

export const DatabaseReconciliationJobSchema = z
  .object({
    scope: z.literal("SUPABASE_MANAGED"),
  })
  .strict();

export type DatabaseReconciliationJob = z.infer<
  typeof DatabaseReconciliationJobSchema
>;

export const DatabaseReconciliationFindingKindSchema = z.enum([
  "PROVIDER_RESOURCE_MISSING",
  "ORPHAN_PROVIDER_RESOURCE",
  "RECOVERY_EXHAUSTED",
]);
export type DatabaseReconciliationFindingKind = z.infer<
  typeof DatabaseReconciliationFindingKindSchema
>;

export const DatabaseReconciliationFindingStatusSchema = z.enum([
  "OPEN",
  "APPROVED",
  "CLEANING",
  "RESOLVED",
  "IGNORED",
]);
export type DatabaseReconciliationFindingStatus = z.infer<
  typeof DatabaseReconciliationFindingStatusSchema
>;

export const DatabaseReconciliationSummarySchema = z
  .object({
    recoveredOperations: z.number().int().nonnegative(),
    exhaustedOperations: z.number().int().nonnegative(),
    missingResources: z.number().int().nonnegative(),
    orphanCandidates: z.number().int().nonnegative(),
    cleanedResources: z.number().int().nonnegative(),
  })
  .strict();

export type DatabaseReconciliationSummary = z.infer<
  typeof DatabaseReconciliationSummarySchema
>;

export const ApproveOrphanCleanupInputSchema = z
  .object({
    findingId: z.string().uuid(),
    externalId: z.string().trim().min(1).max(191),
    approvedBy: z.string().trim().min(1).max(191),
    confirmation: z.literal("APPROVE_ORPHAN_DATABASE_DELETION"),
  })
  .strict();

export type ApproveOrphanCleanupInput = z.infer<
  typeof ApproveOrphanCleanupInputSchema
>;

export const DATABASE_RECONCILIATION_QUEUE_NAME =
  "database-reconciliation" as const;
export const DATABASE_RECONCILIATION_SCHEDULER_ID =
  "supabase-managed-database-reconciliation-v1" as const;

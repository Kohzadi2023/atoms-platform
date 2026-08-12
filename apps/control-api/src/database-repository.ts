import type {
  DatabaseActionInput,
  JsonValue,
  ProvisionDatabaseInput,
  WorkspaceRole,
} from "@atoms/contracts";
import { JsonValueSchema } from "@atoms/contracts";
import {
  Prisma,
  type DatabaseInstance,
  type PrismaClient,
} from "@atoms/db";

import type {
  DatabaseInstanceRecord,
  MigrationArtifactRecord,
} from "./database-domain.js";

export type CreateDatabaseOperationResult =
  | {
      readonly kind: "ok";
      readonly database: DatabaseInstanceRecord;
      readonly replayed: boolean;
    }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "artifact_not_found" }
  | { readonly kind: "destructive_approval_required" }
  | { readonly kind: "idempotency_conflict" };

export type DestroyDatabaseOperationResult =
  | { readonly kind: "ok"; readonly database: DatabaseInstanceRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_status"; readonly status: string };

export interface DatabaseControlRepository {
  getProjectWorkspaceMembership(
    userId: string,
    projectId: string,
  ): Promise<{ readonly workspaceId: string; readonly role: WorkspaceRole } | null>;
  createDatabaseOperation(
    userId: string,
    projectId: string,
    idempotencyKey: string,
    input: ProvisionDatabaseInput,
    now: Date,
  ): Promise<CreateDatabaseOperationResult>;
  getDatabaseInstance(
    userId: string,
    projectId: string,
    databaseInstanceId: string,
  ): Promise<DatabaseInstanceRecord | null>;
  getLatestMigrationArtifact(
    userId: string,
    projectId: string,
  ): Promise<MigrationArtifactRecord | null>;
  requestDatabaseAction(
    userId: string,
    projectId: string,
    databaseInstanceId: string,
    input: DatabaseActionInput,
    now: Date,
  ): Promise<DestroyDatabaseOperationResult>;
  markDatabaseOperationFailed(
    databaseInstanceId: string,
    operationId: string,
    operationVersion: number,
    error: JsonValue,
    now: Date,
  ): Promise<void>;
}

export class PrismaDatabaseControlRepository
  implements DatabaseControlRepository
{
  readonly #prisma: PrismaClient;
  readonly #providerCredentialSecretRef: string;

  constructor(
    prisma: PrismaClient,
    options: { readonly providerCredentialSecretRef?: string } = {},
  ) {
    this.#prisma = prisma;
    this.#providerCredentialSecretRef =
      options.providerCredentialSecretRef ?? "env://SUPABASE_ACCESS_TOKEN";
  }

  async getProjectWorkspaceMembership(
    userId: string,
    projectId: string,
  ): Promise<{ readonly workspaceId: string; readonly role: WorkspaceRole } | null> {
    const membership = await this.#prisma.membership.findFirst({
      where: {
        userId,
        workspace: {
          projects: {
            some: {
              id: projectId,
              archivedAt: null,
            },
          },
        },
      },
      select: {
        workspaceId: true,
        role: true,
      },
    });
    if (membership === null) return null;
    return {
      workspaceId: membership.workspaceId,
      role: membership.role,
    };
  }

  async createDatabaseOperation(
    userId: string,
    projectId: string,
    idempotencyKey: string,
    input: ProvisionDatabaseInput,
    now: Date,
  ): Promise<CreateDatabaseOperationResult> {
    try {
      return await this.#prisma.$transaction(
        async (transaction): Promise<CreateDatabaseOperationResult> => {
          const existing = await transaction.databaseInstance.findUnique({
            where: { idempotencyKey },
          });
          if (existing !== null) {
            return existing.projectId === projectId &&
              existing.migrationArtifactId === input.migrationArtifactId
              ? {
                  kind: "ok",
                  database: toDatabaseRecord(existing),
                  replayed: true,
                }
              : { kind: "idempotency_conflict" };
          }

          const project = await transaction.project.findFirst({
            where: {
              id: projectId,
              archivedAt: null,
              workspace: {
                memberships: {
                  some: { userId },
                },
              },
            },
            select: { id: true, workspaceId: true, name: true },
          });
          if (project === null) return { kind: "project_not_found" };

          const artifact = await transaction.migrationArtifact.findFirst({
            where: {
              id: input.migrationArtifactId,
              projectId,
              status: "VALIDATED",
            },
            select: { id: true, sourceRunId: true, destructive: true },
          });
          if (artifact === null) return { kind: "artifact_not_found" };
          if (artifact.destructive && !input.approveDestructiveChanges) {
            return { kind: "destructive_approval_required" };
          }

          const integration = await transaction.integrationConnection.upsert({
            where: {
              projectId_provider: {
                projectId: project.id,
                provider: "SUPABASE",
              },
            },
            update: {
              status: "CONNECTED",
              credentialSecretRef: this.#providerCredentialSecretRef,
              revokedAt: null,
            },
            create: {
              workspaceId: project.workspaceId,
              projectId: project.id,
              provider: "SUPABASE",
              credentialSecretRef: this.#providerCredentialSecretRef,
            },
          });

          const database = await transaction.databaseInstance.create({
            data: {
              workspaceId: project.workspaceId,
              projectId: project.id,
              migrationArtifactId: artifact.id,
              integrationConnectionId: integration.id,
              provider: input.provider,
              idempotencyKey,
              displayName: project.name,
              region: input.region,
              status: "QUEUED",
              lastHeartbeatAt: now,
              metadata: {
                destructiveApproved:
                  artifact.destructive && input.approveDestructiveChanges,
              },
            },
          });
          await appendRunEvent(
            transaction,
            artifact.sourceRunId,
            database,
            "QUEUED",
            "Database provisioning queued after explicit confirmation",
          );
          return {
            kind: "ok",
            database: toDatabaseRecord(database),
            replayed: false,
          };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (prismaErrorCode(error) !== "P2002" && prismaErrorCode(error) !== "P2034") {
        throw error;
      }
      const existing = await this.#prisma.databaseInstance.findUnique({
        where: { idempotencyKey },
      });
      if (existing === null) throw error;
      return existing.projectId === projectId &&
        existing.migrationArtifactId === input.migrationArtifactId
        ? {
            kind: "ok",
            database: toDatabaseRecord(existing),
            replayed: true,
          }
        : { kind: "idempotency_conflict" };
    }
  }

  async getDatabaseInstance(
    userId: string,
    projectId: string,
    databaseInstanceId: string,
  ): Promise<DatabaseInstanceRecord | null> {
    const database = await this.#prisma.databaseInstance.findFirst({
      where: {
        id: databaseInstanceId,
        projectId,
        project: {
          workspace: {
            memberships: {
              some: { userId },
            },
          },
        },
      },
    });
    return database === null ? null : toDatabaseRecord(database);
  }

  async getLatestMigrationArtifact(
    userId: string,
    projectId: string,
  ): Promise<MigrationArtifactRecord | null> {
    const artifact = await this.#prisma.migrationArtifact.findFirst({
      where: {
        projectId,
        status: "VALIDATED",
        project: {
          workspace: {
            memberships: {
              some: { userId },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    if (artifact === null) return null;
    return {
      id: artifact.id,
      workspaceId: artifact.workspaceId,
      projectId: artifact.projectId,
      sourceRunId: artifact.sourceRunId,
      schemaPath: artifact.schemaPath,
      schemaHash: artifact.schemaHash,
      migrationPaths: zodStringArray(artifact.migrationPaths),
      seedPath: artifact.seedPath,
      destructive: artifact.destructive,
      policyReport: JsonValueSchema.parse(artifact.policyReport),
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    };
  }

  requestDatabaseAction(
    userId: string,
    projectId: string,
    databaseInstanceId: string,
    _input: DatabaseActionInput,
    now: Date,
  ): Promise<DestroyDatabaseOperationResult> {
    return this.#prisma.$transaction(
      async (transaction): Promise<DestroyDatabaseOperationResult> => {
        const current = await transaction.databaseInstance.findFirst({
          where: {
            id: databaseInstanceId,
            projectId,
            project: {
              workspace: {
                memberships: {
                  some: { userId },
                },
              },
            },
          },
          include: { migrationArtifact: { select: { sourceRunId: true } } },
        });
        if (current === null) return { kind: "not_found" };
        if (current.status === "DELETING" || current.status === "DELETED") {
          return { kind: "ok", database: toDatabaseRecord(current) };
        }
        if (!["READY", "ACTIVE", "SUSPENDED", "FAILED"].includes(current.status)) {
          return { kind: "invalid_status", status: current.status };
        }
        const database = await transaction.databaseInstance.update({
          where: { id: current.id },
          data: {
            status: "DELETING",
            operationVersion: { increment: 1 },
            lastHeartbeatAt: now,
            error: Prisma.DbNull,
          },
        });
        if (current.migrationArtifact !== null) {
          await appendRunEvent(
            transaction,
            current.migrationArtifact.sourceRunId,
            database,
            "DELETING",
            "Database deletion queued after explicit confirmation",
          );
        }
        return { kind: "ok", database: toDatabaseRecord(database) };
      },
      { isolationLevel: "Serializable" },
    );
  }

  async markDatabaseOperationFailed(
    databaseInstanceId: string,
    operationId: string,
    operationVersion: number,
    error: JsonValue,
    now: Date,
  ): Promise<void> {
    await this.#prisma.databaseInstance.updateMany({
      where: { id: databaseInstanceId, operationId, operationVersion },
      data: {
        status: "FAILED",
        error: error as Prisma.InputJsonValue,
        lastHeartbeatAt: now,
      },
    });
  }
}

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function zodStringArray(value: unknown): string[] {
  const parsed = JsonValueSchema.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Migration artifact paths are malformed");
  }
  return parsed;
}

function toDatabaseRecord(record: DatabaseInstance): DatabaseInstanceRecord {
  if (record.migrationArtifactId === null || record.region === null) {
    throw new Error("Phase 3 database instance is missing its artifact or region");
  }
  return {
    id: record.id,
    operationId: record.operationId,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    migrationArtifactId: record.migrationArtifactId,
    provider: "SUPABASE",
    externalId: record.externalId,
    displayName: record.displayName,
    databaseName: record.databaseName,
    region: record.region,
    status: record.status === "ACTIVE" ? "READY" : record.status,
    operationVersion: record.operationVersion,
    attempt: record.attempt,
    recoveryCount: record.recoveryCount,
    error: record.error === null ? null : JsonValueSchema.parse(record.error),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
    lastSyncedAt: record.lastSyncedAt,
    readyAt: record.readyAt,
    deletedAt: record.deletedAt,
  };
}

async function appendRunEvent(
  transaction: Prisma.TransactionClient,
  runId: string,
  database: DatabaseInstance,
  status:
    | "QUEUED"
    | "PROVISIONING"
    | "HEALTH_CHECK"
    | "MIGRATING"
    | "READY"
    | "FAILED"
    | "DELETING"
    | "DELETED",
  message: string,
): Promise<void> {
  const run = await transaction.agentRun.update({
    where: { id: runId },
    data: { eventSequence: { increment: 1 } },
    select: { eventSequence: true },
  });
  await transaction.runEvent.create({
    data: {
      runId,
      sequence: run.eventSequence,
      eventType: "integration.status_changed",
      payload: {
        version: "v1",
        integration: "generated-database",
        databaseInstanceId: database.id,
        operationId: database.operationId,
        operationVersion: database.operationVersion,
        provider: "SUPABASE",
        status,
        message,
      },
    },
  });
}

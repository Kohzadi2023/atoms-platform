import type { AgentProjectFile } from "@atoms/agents";
import {
  DatabaseInstanceStatusSchema,
  JsonValueSchema,
  validateRunEventPayload,
  type DatabaseOperationJob,
  type JsonValue,
} from "@atoms/contracts";
import type {
  DatabaseMigrationStepReport,
  DatabaseProvisionResult,
} from "@atoms/database-provider";
import { Prisma, type PrismaClient } from "@atoms/db";

import type {
  DatabaseClaimResult,
  DatabaseExecutionRecord,
  DatabaseOperationRepository,
} from "./database-domain.js";

export class PrismaDatabaseOperationRepository
  implements DatabaseOperationRepository
{
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  claim(job: DatabaseOperationJob, now: Date): Promise<DatabaseClaimResult> {
    return this.#prisma.$transaction(
      async (transaction): Promise<DatabaseClaimResult> => {
        const current = await transaction.databaseInstance.findFirst({
          where: { id: job.databaseInstanceId, operationId: job.operationId },
          include: { migrationArtifact: true },
        });
        if (current === null) return { kind: "missing" };
        if (current.operationVersion !== job.operationVersion) {
          return { kind: "stale", status: "OPERATION_VERSION_MISMATCH" };
        }
        if (current.migrationArtifact === null || current.region === null) {
          return { kind: "stale", status: "MISSING_MIGRATION_ARTIFACT" };
        }

        if (job.command === "destroy") {
          if (current.status === "DELETED") {
            return { kind: "stale", status: current.status };
          }
          if (current.status !== "DELETING") {
            return { kind: "stale", status: current.status };
          }
          await transaction.databaseInstance.update({
            where: { id: current.id },
            data: { lastHeartbeatAt: now, attempt: { increment: 1 } },
          });
          return { kind: "ready", database: toExecutionRecord(current) };
        }

        if (["READY", "ACTIVE", "DELETING", "DELETED"].includes(current.status)) {
          return { kind: "stale", status: current.status };
        }
        const updated = await transaction.databaseInstance.update({
          where: { id: current.id },
          data: {
            status: "PROVISIONING",
            attempt: { increment: 1 },
            lastHeartbeatAt: now,
            error: Prisma.DbNull,
          },
          include: { migrationArtifact: true },
        });
        await appendStatusEvent(
          transaction,
          toExecutionRecord(updated),
          "PROVISIONING",
          "Supabase provisioning started or reconciled",
        );
        return { kind: "ready", database: toExecutionRecord(updated) };
      },
      { isolationLevel: "Serializable" },
    );
  }

  recordProvisioned(
    database: DatabaseExecutionRecord,
    result: DatabaseProvisionResult,
    now: Date,
  ): Promise<boolean> {
    return this.#prisma.$transaction(async (transaction) => {
      const owned = await transaction.databaseInstance.count({
        where: {
          id: database.id,
          operationId: database.operationId,
          operationVersion: database.operationVersion,
          status: "PROVISIONING",
        },
      });
      if (owned !== 1) return false;
      await transaction.secretReference.upsert({
        where: { reference: result.connectionSecretRef },
        update: {
          status: "ACTIVE",
          revokedAt: null,
          purpose: "DATABASE_RUNTIME",
        },
        create: {
          workspaceId: database.workspaceId,
          projectId: database.projectId,
          provider: "VAULT",
          purpose: "DATABASE_RUNTIME",
          reference: result.connectionSecretRef,
        },
      });
      const update = await transaction.databaseInstance.updateMany({
        where: {
          id: database.id,
          operationId: database.operationId,
          operationVersion: database.operationVersion,
          status: "PROVISIONING",
        },
        data: {
          externalId: result.externalId,
          databaseName: result.databaseName,
          region: result.region,
          connectionSecretRef: result.connectionSecretRef,
          providerOperationMetadata: toPrismaJson(
            result.providerOperationMetadata,
          ),
          status: "HEALTH_CHECK",
          lastSyncedAt: now,
          lastHeartbeatAt: now,
        },
      });
      if (update.count !== 1) return false;
      await appendStatusEvent(
        transaction,
        { ...database, externalId: result.externalId },
        "HEALTH_CHECK",
        "Supabase resource exists; waiting for healthy services",
      );
      return true;
    });
  }

  recordHealthCheck(
    database: DatabaseExecutionRecord,
    message: string,
    now: Date,
  ): Promise<boolean> {
    return this.#prisma.$transaction(async (transaction) => {
      const update = await transaction.databaseInstance.updateMany({
        where: {
          id: database.id,
          operationId: database.operationId,
          operationVersion: database.operationVersion,
          status: "HEALTH_CHECK",
        },
        data: { lastHeartbeatAt: now, lastSyncedAt: now },
      });
      if (update.count !== 1) return false;
      await appendStatusEvent(
        transaction,
        database,
        "HEALTH_CHECK",
        message,
      );
      return true;
    });
  }

  startMigration(
    database: DatabaseExecutionRecord,
    now: Date,
  ): Promise<boolean> {
    return this.#prisma.$transaction(async (transaction) => {
      const update = await transaction.databaseInstance.updateMany({
        where: {
          id: database.id,
          operationId: database.operationId,
          operationVersion: database.operationVersion,
          status: "HEALTH_CHECK",
        },
        data: { status: "MIGRATING", lastHeartbeatAt: now },
      });
      if (update.count !== 1) return false;
      await transaction.migrationRun.upsert({
        where: {
          databaseInstanceId_migrationArtifactId: {
            databaseInstanceId: database.id,
            migrationArtifactId: database.migrationArtifact.id,
          },
        },
        update: {
          status: "RUNNING",
          startedAt: now,
          completedAt: null,
          error: Prisma.DbNull,
        },
        create: {
          databaseInstanceId: database.id,
          migrationArtifactId: database.migrationArtifact.id,
          status: "RUNNING",
          schemaHash: database.migrationArtifact.schemaHash,
          destructive: database.migrationArtifact.destructive,
          startedAt: now,
        },
      });
      await appendStatusEvent(
        transaction,
        database,
        "MIGRATING",
        "Applying forward-only migrations and idempotent seed data in E2B",
      );
      return true;
    });
  }

  async listProjectFiles(projectId: string): Promise<readonly AgentProjectFile[]> {
    const files = await this.#prisma.projectFile.findMany({
      where: { projectId },
      orderBy: [{ filePath: "asc" }, { version: "desc" }],
      distinct: ["filePath"],
    });
    return files.map((file) => ({
      path: file.filePath,
      content: file.content,
      version: file.version,
    }));
  }

  completeMigration(
    database: DatabaseExecutionRecord,
    reports: readonly DatabaseMigrationStepReport[],
    now: Date,
  ): Promise<boolean> {
    return this.#prisma.$transaction(async (transaction) => {
      const update = await transaction.databaseInstance.updateMany({
        where: {
          id: database.id,
          operationId: database.operationId,
          operationVersion: database.operationVersion,
          status: "MIGRATING",
        },
        data: {
          status: "READY",
          readyAt: now,
          lastHeartbeatAt: now,
          error: Prisma.DbNull,
        },
      });
      if (update.count !== 1) return false;
      await transaction.migrationRun.update({
        where: {
          databaseInstanceId_migrationArtifactId: {
            databaseInstanceId: database.id,
            migrationArtifactId: database.migrationArtifact.id,
          },
        },
        data: {
          status: "SUCCEEDED",
          commandResults: toPrismaJson(
            reports.map((report) => ({
              ordinal: report.ordinal,
              name: report.name,
              command: report.command,
              startedAt: report.startedAt,
              completedAt: report.completedAt,
              result: report.result,
            })),
          ),
          completedAt: now,
          error: Prisma.DbNull,
        },
      });
      await appendStatusEvent(
        transaction,
        database,
        "READY",
        "Provisioning, health checks, migration, seed, and connectivity checks passed",
      );
      return true;
    });
  }

  completeDestroy(
    database: DatabaseExecutionRecord,
    now: Date,
  ): Promise<boolean> {
    return this.#prisma.$transaction(async (transaction) => {
      const update = await transaction.databaseInstance.updateMany({
        where: {
          id: database.id,
          operationId: database.operationId,
          operationVersion: database.operationVersion,
          status: "DELETING",
        },
        data: {
          status: "DELETED",
          deletedAt: now,
          lastHeartbeatAt: now,
          connectionSecretRef: null,
          error: Prisma.DbNull,
        },
      });
      if (update.count !== 1) return false;
      if (database.connectionSecretRef !== null) {
        await transaction.secretReference.updateMany({
          where: { reference: database.connectionSecretRef },
          data: { status: "REVOKED", revokedAt: now },
        });
      }
      await appendStatusEvent(
        transaction,
        database,
        "DELETED",
        "Provider resource and stored connection capability were revoked",
      );
      return true;
    });
  }

  async fail(
    database: DatabaseExecutionRecord,
    error: JsonValue,
    now: Date,
  ): Promise<void> {
    await this.#prisma.$transaction(async (transaction) => {
      await transaction.databaseInstance.updateMany({
        where: {
          id: database.id,
          operationId: database.operationId,
          operationVersion: database.operationVersion,
        },
        data: {
          status: "FAILED",
          error: toPrismaJson(error),
          lastHeartbeatAt: now,
        },
      });
      await transaction.migrationRun.updateMany({
        where: {
          databaseInstanceId: database.id,
          status: { in: ["QUEUED", "RUNNING"] },
        },
        data: { status: "FAILED", error: toPrismaJson(error), completedAt: now },
      });
      await appendStatusEvent(
        transaction,
        database,
        "FAILED",
        "Database operation failed; diagnostics are available without secret values",
      );
    });
  }
}

function toExecutionRecord(record: {
  readonly id: string;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly region: string | null;
  readonly provider: string;
  readonly externalId: string | null;
  readonly connectionSecretRef: string | null;
  readonly status: string;
  readonly operationVersion: number;
  readonly migrationArtifact: {
    readonly id: string;
    readonly sourceRunId: string;
    readonly schemaHash: string;
    readonly destructive: boolean;
  } | null;
}): DatabaseExecutionRecord {
  if (record.region === null || record.migrationArtifact === null) {
    throw new Error("Database operation is missing its region or migration artifact");
  }
  return {
    id: record.id,
    operationId: record.operationId,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    displayName: record.displayName,
    region: record.region,
    provider: "SUPABASE",
    externalId: record.externalId,
    connectionSecretRef: record.connectionSecretRef,
    status: DatabaseInstanceStatusSchema.parse(
      record.status === "ACTIVE" ? "READY" : record.status,
    ),
    operationVersion: record.operationVersion,
    migrationArtifact: record.migrationArtifact,
  };
}

async function appendStatusEvent(
  transaction: Prisma.TransactionClient,
  database: DatabaseExecutionRecord,
  status:
    | "PROVISIONING"
    | "HEALTH_CHECK"
    | "MIGRATING"
    | "READY"
    | "FAILED"
    | "DELETED",
  message: string,
): Promise<void> {
  const payload = validateRunEventPayload("integration.status_changed", {
    version: "v1",
    integration: "generated-database",
    databaseInstanceId: database.id,
    operationId: database.operationId,
    operationVersion: database.operationVersion,
    provider: "SUPABASE",
    status,
    message,
  });
  const run = await transaction.agentRun.update({
    where: { id: database.migrationArtifact.sourceRunId },
    data: { eventSequence: { increment: 1 } },
    select: { eventSequence: true },
  });
  await transaction.runEvent.create({
    data: {
      runId: database.migrationArtifact.sourceRunId,
      sequence: run.eventSequence,
      eventType: "integration.status_changed",
      payload: toPrismaJson(payload),
    },
  });
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JsonValueSchema.parse(value) as Prisma.InputJsonValue;
}

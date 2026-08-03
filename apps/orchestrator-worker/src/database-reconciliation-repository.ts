import { createHash } from "node:crypto";

import {
  DatabaseInstanceStatusSchema,
  DatabaseReconciliationSummarySchema,
  JsonValueSchema,
  type ApproveOrphanCleanupInput,
  type DatabaseOperationJob,
  type DatabaseReconciliationFindingKind,
  type DatabaseReconciliationSummary,
  type JsonValue,
  validateRunEventPayload,
} from "@atoms/contracts";
import type { ManagedDatabaseResource } from "@atoms/database-provider";
import { Prisma, type PrismaClient } from "@atoms/db";

import type {
  ApproveOrphanCleanupResult,
  BeginReconciliationSweepResult,
  DatabaseRecoveryPlan,
  DatabaseReconciliationRepository,
  OrphanResourceObservation,
  TrackedDatabaseResource,
} from "./database-reconciliation-domain.js";

const RECOVERABLE_STATUSES = [
  "QUEUED",
  "PROVISIONING",
  "HEALTH_CHECK",
  "MIGRATING",
  "DELETING",
  "FAILED",
] as const;

export class PrismaDatabaseReconciliationRepository
  implements DatabaseReconciliationRepository
{
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async beginSweep(input: {
    readonly now: Date;
    readonly staleBefore: Date;
    readonly orphanGraceBefore: Date;
    readonly abandonedSweepBefore: Date;
    readonly dryRun: boolean;
  }): Promise<BeginReconciliationSweepResult> {
    try {
      return await this.#prisma.$transaction(
        async (transaction): Promise<BeginReconciliationSweepResult> => {
          await transaction.databaseReconciliationSweep.updateMany({
            where: {
              provider: "SUPABASE",
              status: "RUNNING",
              startedAt: { lte: input.abandonedSweepBefore },
            },
            data: {
              status: "FAILED",
              completedAt: input.now,
              error: toPrismaJson({
                code: "ABANDONED_RECONCILIATION_SWEEP",
                message: "The previous sweep exceeded its execution lease",
                retryable: true,
              }),
            },
          });
          await transaction.databaseReconciliationFinding.updateMany({
            where: {
              status: "CLEANING",
              sweep: { status: { not: "RUNNING" } },
            },
            data: { status: "APPROVED" },
          });
          const sweep = await transaction.databaseReconciliationSweep.create({
            data: {
              provider: "SUPABASE",
              status: "RUNNING",
              dryRun: input.dryRun,
              staleBefore: input.staleBefore,
              orphanGraceBefore: input.orphanGraceBefore,
              startedAt: input.now,
            },
            select: { id: true },
          });
          return { kind: "started", sweepId: sweep.id };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (prismaErrorCode(error) === "P2002" || prismaErrorCode(error) === "P2034") {
        return { kind: "locked" };
      }
      throw error;
    }
  }

  async listTrackedResources(): Promise<readonly TrackedDatabaseResource[]> {
    const databases = await this.#prisma.databaseInstance.findMany({
      where: { externalId: { not: null }, status: { not: "DELETED" } },
      include: { migrationArtifact: { select: { sourceRunId: true } } },
      orderBy: { id: "asc" },
    });
    return databases.flatMap((database) => {
      if (database.externalId === null || database.migrationArtifact === null) {
        return [];
      }
      return [
        {
          databaseInstanceId: database.id,
          operationId: database.operationId,
          operationVersion: database.operationVersion,
          projectId: database.projectId,
          sourceRunId: database.migrationArtifact.sourceRunId,
          externalId: database.externalId,
          status: DatabaseInstanceStatusSchema.parse(
            database.status === "ACTIVE" ? "READY" : database.status,
          ),
        },
      ];
    });
  }

  recoverStaleOperations(input: {
    readonly sweepId: string;
    readonly staleBefore: Date;
    readonly now: Date;
    readonly maxRecoveryAttempts: number;
    readonly limit: number;
  }): Promise<DatabaseRecoveryPlan> {
    return this.#prisma.$transaction(
      async (transaction): Promise<DatabaseRecoveryPlan> => {
        const candidates = await transaction.databaseInstance.findMany({
          where: {
            status: { in: [...RECOVERABLE_STATUSES] },
            OR: [
              { lastHeartbeatAt: { lte: input.staleBefore } },
              { lastHeartbeatAt: null },
            ],
          },
          include: { migrationArtifact: { select: { sourceRunId: true } } },
          orderBy: [{ lastHeartbeatAt: "asc" }, { createdAt: "asc" }],
          take: input.limit,
        });

        const dispatches: DatabaseOperationJob[] = [];
        let exhaustedOperations = 0;
        for (const candidate of candidates) {
          if (candidate.status === "FAILED" && !isRetryableError(candidate.error)) {
            continue;
          }
          if (candidate.recoveryCount >= input.maxRecoveryAttempts) {
            const exhausted = await transaction.databaseInstance.updateMany({
              where: {
                id: candidate.id,
                operationVersion: candidate.operationVersion,
                recoveryCount: candidate.recoveryCount,
              },
              data: {
                status: "FAILED",
                lastReconciledAt: input.now,
                lastHeartbeatAt: input.now,
                error: toPrismaJson({
                  code: "DATABASE_RECOVERY_EXHAUSTED",
                  message: "Automatic database recovery attempts were exhausted",
                  retryable: false,
                }),
              },
            });
            if (exhausted.count !== 1) continue;
            exhaustedOperations += 1;
            await observeFinding(transaction, {
              sweepId: input.sweepId,
              kind: "RECOVERY_EXHAUSTED",
              stableId: candidate.id,
              databaseInstanceId: candidate.id,
              externalId: candidate.externalId,
              resourceName: candidate.displayName,
              details: {
                operationId: candidate.operationId,
                operationVersion: candidate.operationVersion,
                recoveryCount: candidate.recoveryCount,
              },
              now: input.now,
              cleanupAfter: null,
            });
            if (candidate.migrationArtifact !== null) {
              await appendIntegrationEvent(transaction, {
                runId: candidate.migrationArtifact.sourceRunId,
                databaseInstanceId: candidate.id,
                operationId: candidate.operationId,
                operationVersion: candidate.operationVersion,
                status: "FAILED",
                message: "Automatic recovery attempts were exhausted; operator action is required",
              });
            }
            continue;
          }

          const nextVersion = candidate.operationVersion + 1;
          const updated = await transaction.databaseInstance.updateMany({
            where: {
              id: candidate.id,
              operationVersion: candidate.operationVersion,
              recoveryCount: candidate.recoveryCount,
              status: candidate.status,
            },
            data: {
              operationVersion: nextVersion,
              recoveryCount: { increment: 1 },
              lastReconciledAt: input.now,
              lastHeartbeatAt: input.now,
            },
          });
          if (updated.count !== 1) continue;
          const command = candidate.status === "DELETING" ? "destroy" : "provision";
          dispatches.push({
            operationId: candidate.operationId,
            databaseInstanceId: candidate.id,
            operationVersion: nextVersion,
            command,
          });
          if (candidate.migrationArtifact !== null) {
            await appendIntegrationEvent(transaction, {
              runId: candidate.migrationArtifact.sourceRunId,
              databaseInstanceId: candidate.id,
              operationId: candidate.operationId,
              operationVersion: nextVersion,
              status:
                candidate.status === "FAILED" ? "FAILED" :
                DatabaseInstanceStatusSchema.parse(
                  candidate.status === "ACTIVE" ? "READY" : candidate.status,
                ),
              message: `Reconciliation fenced the stale execution and dispatched recovery ${String(candidate.recoveryCount + 1)}`,
            });
          }
        }
        return { dispatches, exhaustedOperations };
      },
      { isolationLevel: "Serializable" },
    );
  }

  async recordRecoveryDispatchFailure(
    job: DatabaseOperationJob,
    error: JsonValue,
    now: Date,
  ): Promise<void> {
    await this.#prisma.$transaction(async (transaction) => {
      const current = await transaction.databaseInstance.findFirst({
        where: {
          id: job.databaseInstanceId,
          operationId: job.operationId,
          operationVersion: job.operationVersion,
        },
        include: { migrationArtifact: { select: { sourceRunId: true } } },
      });
      if (current === null) return;
      await transaction.databaseInstance.update({
        where: { id: current.id },
        data: {
          status: "FAILED",
          error: toPrismaJson(error),
          lastHeartbeatAt: now,
          lastReconciledAt: now,
        },
      });
      if (current.migrationArtifact !== null) {
        await appendIntegrationEvent(transaction, {
          runId: current.migrationArtifact.sourceRunId,
          databaseInstanceId: current.id,
          operationId: current.operationId,
          operationVersion: current.operationVersion,
          status: "FAILED",
          message: "Recovery dispatch failed before a worker could claim it",
        });
      }
    });
  }

  async observeMissingResource(
    sweepId: string,
    database: TrackedDatabaseResource,
    now: Date,
  ): Promise<void> {
    await this.#prisma.$transaction(async (transaction) => {
      const finding = await observeFinding(transaction, {
        sweepId,
        kind: "PROVIDER_RESOURCE_MISSING",
        stableId: database.databaseInstanceId,
        databaseInstanceId: database.databaseInstanceId,
        externalId: database.externalId,
        resourceName: null,
        details: {
          operationId: database.operationId,
          operationVersion: database.operationVersion,
          localStatus: database.status,
        },
        now,
        cleanupAfter: null,
      });
      if (finding.observationCount < 2) return;
      if (!["READY", "SUSPENDED"].includes(database.status)) return;
      const updated = await transaction.databaseInstance.updateMany({
        where: {
          id: database.databaseInstanceId,
          operationVersion: database.operationVersion,
          status: { in: ["READY", "ACTIVE", "SUSPENDED"] },
        },
        data: {
          status: "FAILED",
          lastReconciledAt: now,
          error: toPrismaJson({
            code: "DATABASE_PROVIDER_RESOURCE_MISSING",
            message: "The tracked provider resource was absent in two consecutive inventories",
            retryable: false,
          }),
        },
      });
      if (updated.count === 1) {
        await appendIntegrationEvent(transaction, {
          runId: database.sourceRunId,
          databaseInstanceId: database.databaseInstanceId,
          operationId: database.operationId,
          operationVersion: database.operationVersion,
          status: "FAILED",
          message: "Provider resource is missing; no automatic replacement was created",
        });
      }
    });
  }

  async resolveMissingResource(
    databaseInstanceId: string,
    now: Date,
  ): Promise<void> {
    await this.#prisma.databaseReconciliationFinding.updateMany({
      where: {
        databaseInstanceId,
        kind: "PROVIDER_RESOURCE_MISSING",
        status: { in: ["OPEN", "APPROVED"] },
      },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        resolution: "PROVIDER_RESOURCE_PRESENT",
      },
    });
  }

  observeOrphanResource(
    sweepId: string,
    resource: ManagedDatabaseResource,
    now: Date,
    graceMs: number,
  ): Promise<OrphanResourceObservation> {
    return this.#prisma.$transaction(async (transaction) => {
      const finding = await observeFinding(transaction, {
        sweepId,
        kind: "ORPHAN_PROVIDER_RESOURCE",
        stableId: resource.externalId,
        databaseInstanceId: null,
        externalId: resource.externalId,
        resourceName: resource.name,
        details: {
          region: resource.region,
          providerStatus: resource.status,
          providerCreatedAt: resource.createdAt,
        },
        now,
        cleanupAfter: new Date(now.getTime() + graceMs),
      });
      if (finding.cleanupAfter === null) {
        throw new Error("Orphan finding is missing its cleanup boundary");
      }
      return {
        findingId: finding.id,
        status: finding.status,
        observationCount: finding.observationCount,
        cleanupAfter: finding.cleanupAfter,
      };
    });
  }

  claimOrphanCleanup(
    sweepId: string,
    findingId: string,
    externalId: string,
    now: Date,
  ): Promise<boolean> {
    return this.#prisma.$transaction(
      async (transaction): Promise<boolean> => {
        const sweep = await transaction.databaseReconciliationSweep.findFirst({
          where: { id: sweepId, provider: "SUPABASE", status: "RUNNING" },
          select: { id: true },
        });
        if (sweep === null) return false;
        const finding = await transaction.databaseReconciliationFinding.findFirst({
          where: {
            id: findingId,
            sweepId,
            provider: "SUPABASE",
            kind: "ORPHAN_PROVIDER_RESOURCE",
            status: "APPROVED",
            externalId,
            observationCount: { gte: 2 },
            cleanupAfter: { lte: now },
          },
          select: { id: true },
        });
        if (finding === null) return false;
        const tracked = await transaction.databaseInstance.count({
          where: { provider: "SUPABASE", externalId, status: { not: "DELETED" } },
        });
        if (tracked > 0) return false;
        const claimed = await transaction.databaseReconciliationFinding.updateMany({
          where: { id: finding.id, sweepId, status: "APPROVED", externalId },
          data: { status: "CLEANING", lastSeenAt: now },
        });
        return claimed.count === 1;
      },
      { isolationLevel: "Serializable" },
    );
  }

  async releaseOrphanCleanupClaim(
    findingId: string,
    now: Date,
  ): Promise<void> {
    await this.#prisma.databaseReconciliationFinding.updateMany({
      where: { id: findingId, status: "CLEANING" },
      data: { status: "APPROVED", lastSeenAt: now },
    });
  }

  async resolveOrphanResource(
    externalId: string,
    resolution: "ADOPTED" | "NO_LONGER_PRESENT" | "DELETED_AFTER_APPROVAL",
    now: Date,
  ): Promise<void> {
    await this.#prisma.databaseReconciliationFinding.updateMany({
      where: {
        provider: "SUPABASE",
        kind: "ORPHAN_PROVIDER_RESOURCE",
        externalId,
        status: { in: ["OPEN", "APPROVED", "CLEANING"] },
      },
      data: { status: "RESOLVED", resolution, resolvedAt: now },
    });
  }

  async resolveUnseenOrphanResources(
    seenExternalIds: readonly string[],
    now: Date,
  ): Promise<void> {
    await this.#prisma.databaseReconciliationFinding.updateMany({
      where: {
        provider: "SUPABASE",
        kind: "ORPHAN_PROVIDER_RESOURCE",
        status: { in: ["OPEN", "APPROVED", "CLEANING"] },
        externalId:
          seenExternalIds.length === 0
            ? { not: null }
            : { notIn: [...seenExternalIds] },
      },
      data: {
        status: "RESOLVED",
        resolution: "NO_LONGER_PRESENT",
        resolvedAt: now,
      },
    });
  }

  async completeSweep(
    sweepId: string,
    summary: DatabaseReconciliationSummary,
    now: Date,
  ): Promise<void> {
    await this.#prisma.databaseReconciliationSweep.updateMany({
      where: { id: sweepId, status: "RUNNING" },
      data: {
        status: "SUCCEEDED",
        summary: toPrismaJson(DatabaseReconciliationSummarySchema.parse(summary)),
        completedAt: now,
        error: Prisma.DbNull,
      },
    });
  }

  async failSweep(sweepId: string, error: JsonValue, now: Date): Promise<void> {
    await this.#prisma.databaseReconciliationSweep.updateMany({
      where: { id: sweepId, status: "RUNNING" },
      data: {
        status: "FAILED",
        error: toPrismaJson(error),
        completedAt: now,
      },
    });
  }

  async approveOrphanCleanup(
    input: ApproveOrphanCleanupInput,
    now: Date,
  ): Promise<ApproveOrphanCleanupResult> {
    return this.#prisma.$transaction(
      async (transaction): Promise<ApproveOrphanCleanupResult> => {
        const finding = await transaction.databaseReconciliationFinding.findFirst({
          where: {
            id: input.findingId,
            externalId: input.externalId,
            provider: "SUPABASE",
            kind: "ORPHAN_PROVIDER_RESOURCE",
          },
        });
        if (finding === null) return { kind: "not_found" };
        if (finding.status === "APPROVED") {
          return { kind: "approved", findingId: finding.id };
        }
        if (finding.status !== "OPEN") {
          return {
            kind: "not_ready",
            reason: `Finding is ${finding.status}`,
          };
        }
        if (finding.observationCount < 2) {
          return {
            kind: "not_ready",
            reason: "A second independent inventory observation is required",
          };
        }
        const updated = await transaction.databaseReconciliationFinding.updateMany({
          where: { id: finding.id, status: "OPEN", externalId: input.externalId },
          data: {
            status: "APPROVED",
            approvedBy: input.approvedBy,
            approvedAt: now,
          },
        });
        return updated.count === 1
          ? { kind: "approved", findingId: finding.id }
          : { kind: "not_ready", reason: "Finding changed concurrently" };
      },
      { isolationLevel: "Serializable" },
    );
  }
}

interface FindingInput {
  readonly sweepId: string;
  readonly kind: DatabaseReconciliationFindingKind;
  readonly stableId: string;
  readonly databaseInstanceId: string | null;
  readonly externalId: string | null;
  readonly resourceName: string | null;
  readonly details: JsonValue;
  readonly now: Date;
  readonly cleanupAfter: Date | null;
}

async function observeFinding(
  transaction: Prisma.TransactionClient,
  input: FindingInput,
) {
  const fingerprint = findingFingerprint(input.kind, input.stableId);
  const existing = await transaction.databaseReconciliationFinding.findUnique({
    where: { fingerprint },
  });
  if (existing === null) {
    return transaction.databaseReconciliationFinding.create({
      data: {
        fingerprint,
        sweepId: input.sweepId,
        provider: "SUPABASE",
        kind: input.kind,
        status: "OPEN",
        databaseInstanceId: input.databaseInstanceId,
        externalId: input.externalId,
        resourceName: input.resourceName,
        details: toPrismaJson(input.details),
        observationCount: 1,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        cleanupAfter: input.cleanupAfter,
      },
    });
  }
  if (existing.status === "RESOLVED") {
    return transaction.databaseReconciliationFinding.update({
      where: { id: existing.id },
      data: {
        sweepId: input.sweepId,
        status: "OPEN",
        databaseInstanceId: input.databaseInstanceId,
        externalId: input.externalId,
        resourceName: input.resourceName,
        details: toPrismaJson(input.details),
        observationCount: 1,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        cleanupAfter: input.cleanupAfter,
        approvedBy: null,
        approvedAt: null,
        resolvedAt: null,
        resolution: null,
      },
    });
  }
  return transaction.databaseReconciliationFinding.update({
    where: { id: existing.id },
    data: {
      sweepId: input.sweepId,
      databaseInstanceId: input.databaseInstanceId,
      externalId: input.externalId,
      resourceName: input.resourceName,
      details: toPrismaJson(input.details),
      observationCount: { increment: 1 },
      lastSeenAt: input.now,
    },
  });
}

async function appendIntegrationEvent(
  transaction: Prisma.TransactionClient,
  input: {
    readonly runId: string;
    readonly databaseInstanceId: string;
    readonly operationId: string;
    readonly operationVersion: number;
    readonly status:
      | "QUEUED"
      | "PROVISIONING"
      | "HEALTH_CHECK"
      | "MIGRATING"
      | "READY"
      | "SUSPENDED"
      | "FAILED"
      | "DELETING"
      | "DELETED";
    readonly message: string;
  },
): Promise<void> {
  const payload = validateRunEventPayload("integration.status_changed", {
    version: "v1",
    integration: "generated-database",
    databaseInstanceId: input.databaseInstanceId,
    operationId: input.operationId,
    operationVersion: input.operationVersion,
    provider: "SUPABASE",
    status: input.status,
    message: input.message,
  });
  const run = await transaction.agentRun.update({
    where: { id: input.runId },
    data: { eventSequence: { increment: 1 } },
    select: { eventSequence: true },
  });
  await transaction.runEvent.create({
    data: {
      runId: input.runId,
      sequence: run.eventSequence,
      eventType: "integration.status_changed",
      payload: toPrismaJson(payload),
    },
  });
}

function findingFingerprint(
  kind: DatabaseReconciliationFindingKind,
  stableId: string,
): string {
  return createHash("sha256")
    .update(`SUPABASE:${kind}:${stableId}`)
    .digest("hex");
}

function isRetryableError(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return "retryable" in value && value.retryable === true;
}

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JsonValueSchema.parse(value) as Prisma.InputJsonValue;
}

import {
  DatabaseReconciliationSummarySchema,
  type DatabaseReconciliationSummary,
  type JsonValue,
} from "@atoms/contracts";
import {
  DatabaseProviderError,
  type DatabaseProvider,
} from "@atoms/database-provider";

import type {
  DatabaseReconciliationRepository,
  DatabaseRecoveryQueue,
} from "./database-reconciliation-domain.js";

export type DatabaseReconciliationResult =
  | { readonly outcome: "completed"; readonly summary: DatabaseReconciliationSummary }
  | { readonly outcome: "skipped"; readonly reason: "locked" };

export interface DatabaseReconcilerOptions {
  readonly repository: DatabaseReconciliationRepository;
  readonly provider: DatabaseProvider;
  readonly recoveryQueue: DatabaseRecoveryQueue;
  readonly staleAfterMs?: number;
  readonly orphanGraceMs?: number;
  readonly abandonedSweepAfterMs?: number;
  readonly maxRecoveryAttempts?: number;
  readonly recoveryBatchSize?: number;
  readonly cleanupApprovedOrphans?: boolean;
  readonly now?: () => Date;
}

export class DatabaseReconciler {
  readonly #repository: DatabaseReconciliationRepository;
  readonly #provider: DatabaseProvider;
  readonly #recoveryQueue: DatabaseRecoveryQueue;
  readonly #staleAfterMs: number;
  readonly #orphanGraceMs: number;
  readonly #abandonedSweepAfterMs: number;
  readonly #maxRecoveryAttempts: number;
  readonly #recoveryBatchSize: number;
  readonly #cleanupApprovedOrphans: boolean;
  readonly #now: () => Date;

  constructor(options: DatabaseReconcilerOptions) {
    this.#repository = options.repository;
    this.#provider = options.provider;
    this.#recoveryQueue = options.recoveryQueue;
    this.#staleAfterMs = options.staleAfterMs ?? 20 * 60_000;
    this.#orphanGraceMs = options.orphanGraceMs ?? 24 * 60 * 60_000;
    this.#abandonedSweepAfterMs =
      options.abandonedSweepAfterMs ?? 30 * 60_000;
    this.#maxRecoveryAttempts = options.maxRecoveryAttempts ?? 3;
    this.#recoveryBatchSize = options.recoveryBatchSize ?? 100;
    this.#cleanupApprovedOrphans = options.cleanupApprovedOrphans ?? false;
    this.#now = options.now ?? (() => new Date());
  }

  async reconcile(): Promise<DatabaseReconciliationResult> {
    const startedAt = this.#now();
    const staleBefore = new Date(startedAt.getTime() - this.#staleAfterMs);
    const orphanGraceBefore = new Date(
      startedAt.getTime() - this.#orphanGraceMs,
    );
    const begin = await this.#repository.beginSweep({
      now: startedAt,
      staleBefore,
      orphanGraceBefore,
      abandonedSweepBefore: new Date(
        startedAt.getTime() - this.#abandonedSweepAfterMs,
      ),
      dryRun: !this.#cleanupApprovedOrphans,
    });
    if (begin.kind === "locked") {
      return { outcome: "skipped", reason: "locked" };
    }

    try {
      // Provider inventory is fetched before mutating recovery state. An
      // unavailable provider therefore fails the sweep closed.
      const providerResources = await this.#provider.listManagedResources();
      const trackedResources = await this.#repository.listTrackedResources();
      const recovery = await this.#repository.recoverStaleOperations({
        sweepId: begin.sweepId,
        staleBefore,
        now: this.#now(),
        maxRecoveryAttempts: this.#maxRecoveryAttempts,
        limit: this.#recoveryBatchSize,
      });

      let recoveredOperations = 0;
      for (const job of recovery.dispatches) {
        try {
          await this.#recoveryQueue.enqueue(job);
          recoveredOperations += 1;
        } catch (error) {
          await this.#repository.recordRecoveryDispatchFailure(
            job,
            toReconciliationError(error, "DATABASE_RECOVERY_ENQUEUE_FAILED"),
            this.#now(),
          );
          throw error;
        }
      }

      const providerById = new Map(
        providerResources.map((resource) => [resource.externalId, resource]),
      );
      const trackedByExternalId = new Map(
        trackedResources.map((resource) => [resource.externalId, resource]),
      );

      let missingResources = 0;
      for (const tracked of trackedResources) {
        if (providerById.has(tracked.externalId)) {
          await this.#repository.resolveMissingResource(
            tracked.databaseInstanceId,
            this.#now(),
          );
        } else {
          missingResources += 1;
          await this.#repository.observeMissingResource(
            begin.sweepId,
            tracked,
            this.#now(),
          );
        }
      }

      let orphanCandidates = 0;
      let cleanedResources = 0;
      for (const resource of providerResources) {
        if (trackedByExternalId.has(resource.externalId)) {
          await this.#repository.resolveOrphanResource(
            resource.externalId,
            "ADOPTED",
            this.#now(),
          );
          continue;
        }

        orphanCandidates += 1;
        const observation = await this.#repository.observeOrphanResource(
          begin.sweepId,
          resource,
          this.#now(),
          this.#orphanGraceMs,
        );
        const eligible =
          observation.status === "APPROVED" &&
          observation.observationCount >= 2 &&
          observation.cleanupAfter.getTime() <= this.#now().getTime();
        if (!this.#cleanupApprovedOrphans || !eligible) continue;

        const claimed = await this.#repository.claimOrphanCleanup(
          begin.sweepId,
          observation.findingId,
          resource.externalId,
          this.#now(),
        );
        if (!claimed) continue;
        try {
          await this.#provider.destroy(resource.externalId);
        } catch (error) {
          await this.#repository.releaseOrphanCleanupClaim(
            observation.findingId,
            this.#now(),
          );
          throw error;
        }
        await this.#repository.resolveOrphanResource(
          resource.externalId,
          "DELETED_AFTER_APPROVAL",
          this.#now(),
        );
        cleanedResources += 1;
      }
      await this.#repository.resolveUnseenOrphanResources(
        providerResources.map((resource) => resource.externalId),
        this.#now(),
      );

      const summary = DatabaseReconciliationSummarySchema.parse({
        recoveredOperations,
        exhaustedOperations: recovery.exhaustedOperations,
        missingResources,
        orphanCandidates,
        cleanedResources,
      });
      await this.#repository.completeSweep(
        begin.sweepId,
        summary,
        this.#now(),
      );
      return { outcome: "completed", summary };
    } catch (error) {
      await this.#repository
        .failSweep(
          begin.sweepId,
          toReconciliationError(error, "DATABASE_RECONCILIATION_FAILED"),
          this.#now(),
        )
        .catch(() => undefined);
      throw error;
    }
  }
}

function toReconciliationError(error: unknown, fallbackCode: string): JsonValue {
  if (error instanceof DatabaseProviderError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : "Unknown reconciliation error",
    retryable: true,
  };
}

import type {
  ApproveOrphanCleanupInput,
  DatabaseInstanceStatus,
  DatabaseOperationJob,
  DatabaseReconciliationFindingStatus,
  DatabaseReconciliationSummary,
  JsonValue,
} from "@atoms/contracts";
import type { ManagedDatabaseResource } from "@atoms/database-provider";

export interface TrackedDatabaseResource {
  readonly databaseInstanceId: string;
  readonly operationId: string;
  readonly operationVersion: number;
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly externalId: string;
  readonly status: DatabaseInstanceStatus;
}

export interface DatabaseRecoveryPlan {
  readonly dispatches: readonly DatabaseOperationJob[];
  readonly exhaustedOperations: number;
}

export interface OrphanResourceObservation {
  readonly findingId: string;
  readonly status: DatabaseReconciliationFindingStatus;
  readonly observationCount: number;
  readonly cleanupAfter: Date;
}

export type BeginReconciliationSweepResult =
  | { readonly kind: "started"; readonly sweepId: string }
  | { readonly kind: "locked" };

export type ApproveOrphanCleanupResult =
  | { readonly kind: "approved"; readonly findingId: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_ready"; readonly reason: string };

export interface DatabaseRecoveryQueue {
  enqueue(job: DatabaseOperationJob): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseReconciliationRepository {
  beginSweep(input: {
    readonly now: Date;
    readonly staleBefore: Date;
    readonly orphanGraceBefore: Date;
    readonly abandonedSweepBefore: Date;
    readonly dryRun: boolean;
  }): Promise<BeginReconciliationSweepResult>;
  listTrackedResources(): Promise<readonly TrackedDatabaseResource[]>;
  recoverStaleOperations(input: {
    readonly sweepId: string;
    readonly staleBefore: Date;
    readonly now: Date;
    readonly maxRecoveryAttempts: number;
    readonly limit: number;
  }): Promise<DatabaseRecoveryPlan>;
  recordRecoveryDispatchFailure(
    job: DatabaseOperationJob,
    error: JsonValue,
    now: Date,
  ): Promise<void>;
  observeMissingResource(
    sweepId: string,
    database: TrackedDatabaseResource,
    now: Date,
  ): Promise<void>;
  resolveMissingResource(databaseInstanceId: string, now: Date): Promise<void>;
  observeOrphanResource(
    sweepId: string,
    resource: ManagedDatabaseResource,
    now: Date,
    graceMs: number,
  ): Promise<OrphanResourceObservation>;
  claimOrphanCleanup(
    sweepId: string,
    findingId: string,
    externalId: string,
    now: Date,
  ): Promise<boolean>;
  releaseOrphanCleanupClaim(findingId: string, now: Date): Promise<void>;
  resolveOrphanResource(
    externalId: string,
    resolution: "ADOPTED" | "NO_LONGER_PRESENT" | "DELETED_AFTER_APPROVAL",
    now: Date,
  ): Promise<void>;
  resolveUnseenOrphanResources(
    seenExternalIds: readonly string[],
    now: Date,
  ): Promise<void>;
  completeSweep(
    sweepId: string,
    summary: DatabaseReconciliationSummary,
    now: Date,
  ): Promise<void>;
  failSweep(sweepId: string, error: JsonValue, now: Date): Promise<void>;
  approveOrphanCleanup(
    input: ApproveOrphanCleanupInput,
    now: Date,
  ): Promise<ApproveOrphanCleanupResult>;
}

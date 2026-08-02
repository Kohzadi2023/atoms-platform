import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApproveOrphanCleanupInput,
  DatabaseOperationJob,
  DatabaseReconciliationSummary,
  JsonValue,
} from "@atoms/contracts";
import type {
  DatabaseHealthStatus,
  DatabaseProvider,
  DatabaseProvisionInput,
  DatabaseProvisionResult,
  ManagedDatabaseResource,
  SecretLease,
} from "@atoms/database-provider";

import type {
  ApproveOrphanCleanupResult,
  BeginReconciliationSweepResult,
  DatabaseRecoveryPlan,
  DatabaseReconciliationRepository,
  DatabaseRecoveryQueue,
  OrphanResourceObservation,
  TrackedDatabaseResource,
} from "./database-reconciliation-domain.js";
import { DatabaseReconciler } from "./database-reconciler.js";

const FIXED_NOW = new Date("2026-08-01T22:00:00.000Z");
const DATABASE_ID = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "00000000-0000-4000-8000-000000000002";
const PROJECT_ID = "00000000-0000-4000-8000-000000000003";
const RUN_ID = "00000000-0000-4000-8000-000000000004";

const managed: ManagedDatabaseResource = {
  externalId: "tracked-resource",
  name: "atoms-customer-portal-000000000000",
  region: "americas",
  status: "ACTIVE_HEALTHY",
  createdAt: "2026-07-30T12:00:00.000Z",
};

const orphan: ManagedDatabaseResource = {
  externalId: "orphan-resource",
  name: "atoms-orphan-project-111111111111",
  region: "americas",
  status: "ACTIVE_HEALTHY",
  createdAt: "2026-07-29T12:00:00.000Z",
};

const tracked: TrackedDatabaseResource = {
  databaseInstanceId: DATABASE_ID,
  operationId: OPERATION_ID,
  operationVersion: 1,
  projectId: PROJECT_ID,
  sourceRunId: RUN_ID,
  externalId: managed.externalId,
  status: "READY",
};

class MemoryReconciliationRepository
  implements DatabaseReconciliationRepository
{
  beginResult: BeginReconciliationSweepResult = {
    kind: "started",
    sweepId: "00000000-0000-4000-8000-000000000010",
  };
  trackedResources: TrackedDatabaseResource[] = [];
  recoveryPlan: DatabaseRecoveryPlan = {
    dispatches: [],
    exhaustedOperations: 0,
  };
  orphanObservation: OrphanResourceObservation = {
    findingId: "00000000-0000-4000-8000-000000000011",
    status: "OPEN",
    observationCount: 1,
    cleanupAfter: new Date("2026-08-02T22:00:00.000Z"),
  };
  missing: string[] = [];
  resolvedMissing: string[] = [];
  observedOrphans: string[] = [];
  cleanupClaims: string[] = [];
  releasedClaims: string[] = [];
  resolvedOrphans: Array<{ externalId: string; resolution: string }> = [];
  unseenInventory: string[] = [];
  completed: DatabaseReconciliationSummary | null = null;
  failed: JsonValue | null = null;

  async beginSweep(): Promise<BeginReconciliationSweepResult> {
    return this.beginResult;
  }
  async listTrackedResources(): Promise<readonly TrackedDatabaseResource[]> {
    return this.trackedResources;
  }
  async recoverStaleOperations(): Promise<DatabaseRecoveryPlan> {
    return this.recoveryPlan;
  }
  async recordRecoveryDispatchFailure(
    _job: DatabaseOperationJob,
    error: JsonValue,
  ): Promise<void> {
    this.failed = error;
  }
  async observeMissingResource(
    _sweepId: string,
    database: TrackedDatabaseResource,
  ): Promise<void> {
    this.missing.push(database.externalId);
  }
  async resolveMissingResource(databaseInstanceId: string): Promise<void> {
    this.resolvedMissing.push(databaseInstanceId);
  }
  async observeOrphanResource(
    _sweepId: string,
    resource: ManagedDatabaseResource,
  ): Promise<OrphanResourceObservation> {
    this.observedOrphans.push(resource.externalId);
    return this.orphanObservation;
  }
  async claimOrphanCleanup(
    _sweepId: string,
    findingId: string,
    externalId: string,
  ): Promise<boolean> {
    this.cleanupClaims.push(`${findingId}:${externalId}`);
    return true;
  }
  async releaseOrphanCleanupClaim(findingId: string): Promise<void> {
    this.releasedClaims.push(findingId);
  }
  async resolveOrphanResource(
    externalId: string,
    resolution: "ADOPTED" | "NO_LONGER_PRESENT" | "DELETED_AFTER_APPROVAL",
  ): Promise<void> {
    this.resolvedOrphans.push({ externalId, resolution });
  }
  async resolveUnseenOrphanResources(
    seenExternalIds: readonly string[],
  ): Promise<void> {
    this.unseenInventory = [...seenExternalIds];
  }
  async completeSweep(
    _sweepId: string,
    summary: DatabaseReconciliationSummary,
  ): Promise<void> {
    this.completed = summary;
  }
  async failSweep(
    _sweepId: string,
    error: JsonValue,
  ): Promise<void> {
    this.failed = error;
  }
  async approveOrphanCleanup(
    _input: ApproveOrphanCleanupInput,
  ): Promise<ApproveOrphanCleanupResult> {
    return { kind: "approved", findingId: this.orphanObservation.findingId };
  }
}

class InventoryProvider implements DatabaseProvider {
  readonly name = "SUPABASE" as const;
  resources: ManagedDatabaseResource[] = [];
  destroyed: string[] = [];
  listCalls = 0;
  destroyError: Error | null = null;

  async listManagedResources(): Promise<readonly ManagedDatabaseResource[]> {
    this.listCalls += 1;
    return this.resources;
  }
  async provision(
    _input: DatabaseProvisionInput,
  ): Promise<DatabaseProvisionResult> {
    throw new Error("not used");
  }
  async getHealth(): Promise<DatabaseHealthStatus> {
    throw new Error("not used");
  }
  async getEphemeralConnection(): Promise<SecretLease> {
    throw new Error("not used");
  }
  async destroy(externalId: string): Promise<void> {
    if (this.destroyError !== null) throw this.destroyError;
    this.destroyed.push(externalId);
  }
}

class MemoryRecoveryQueue implements DatabaseRecoveryQueue {
  jobs: DatabaseOperationJob[] = [];
  async enqueue(job: DatabaseOperationJob): Promise<void> {
    this.jobs.push(job);
  }
  async close(): Promise<void> {}
}

test("reconciler fences stale work, compares inventory, and remains report-only by default", async () => {
  const repository = new MemoryReconciliationRepository();
  repository.trackedResources = [
    tracked,
    { ...tracked, databaseInstanceId: "00000000-0000-4000-8000-000000000020", externalId: "missing-resource" },
  ];
  repository.recoveryPlan = {
    dispatches: [
      {
        operationId: OPERATION_ID,
        databaseInstanceId: DATABASE_ID,
        operationVersion: 2,
        command: "provision",
      },
    ],
    exhaustedOperations: 1,
  };
  const provider = new InventoryProvider();
  provider.resources = [managed, orphan];
  const queue = new MemoryRecoveryQueue();
  const reconciler = new DatabaseReconciler({
    repository,
    provider,
    recoveryQueue: queue,
    now: () => FIXED_NOW,
  });

  const result = await reconciler.reconcile();
  assert.deepEqual(result, {
    outcome: "completed",
    summary: {
      recoveredOperations: 1,
      exhaustedOperations: 1,
      missingResources: 1,
      orphanCandidates: 1,
      cleanedResources: 0,
    },
  });
  assert.equal(queue.jobs[0]?.operationVersion, 2);
  assert.deepEqual(repository.missing, ["missing-resource"]);
  assert.deepEqual(repository.observedOrphans, ["orphan-resource"]);
  assert.deepEqual(provider.destroyed, []);
});

test("approved orphan is deleted only after repeated observation and grace", async () => {
  const repository = new MemoryReconciliationRepository();
  repository.orphanObservation = {
    ...repository.orphanObservation,
    status: "APPROVED",
    observationCount: 2,
    cleanupAfter: new Date("2026-08-01T21:59:00.000Z"),
  };
  const provider = new InventoryProvider();
  provider.resources = [orphan];
  const reconciler = new DatabaseReconciler({
    repository,
    provider,
    recoveryQueue: new MemoryRecoveryQueue(),
    cleanupApprovedOrphans: true,
    now: () => FIXED_NOW,
  });

  const result = await reconciler.reconcile();
  assert.equal(result.outcome, "completed");
  assert.deepEqual(provider.destroyed, [orphan.externalId]);
  assert.equal(repository.cleanupClaims.length, 1);
  assert.deepEqual(repository.resolvedOrphans, [
    {
      externalId: orphan.externalId,
      resolution: "DELETED_AFTER_APPROVAL",
    },
  ]);
  assert.equal(repository.completed?.cleanedResources, 1);
});

test("overlapping scheduled sweep is skipped before provider access", async () => {
  const repository = new MemoryReconciliationRepository();
  repository.beginResult = { kind: "locked" };
  const provider = new InventoryProvider();
  const reconciler = new DatabaseReconciler({
    repository,
    provider,
    recoveryQueue: new MemoryRecoveryQueue(),
    now: () => FIXED_NOW,
  });

  assert.deepEqual(await reconciler.reconcile(), {
    outcome: "skipped",
    reason: "locked",
  });
  assert.equal(provider.listCalls, 0);
});

test("failed provider deletion releases the durable cleanup claim", async () => {
  const repository = new MemoryReconciliationRepository();
  repository.orphanObservation = {
    ...repository.orphanObservation,
    status: "APPROVED",
    observationCount: 2,
    cleanupAfter: new Date("2026-08-01T21:00:00.000Z"),
  };
  const provider = new InventoryProvider();
  provider.resources = [orphan];
  provider.destroyError = new Error("provider unavailable");
  const reconciler = new DatabaseReconciler({
    repository,
    provider,
    recoveryQueue: new MemoryRecoveryQueue(),
    cleanupApprovedOrphans: true,
    now: () => FIXED_NOW,
  });

  await assert.rejects(() => reconciler.reconcile(), /provider unavailable/);
  assert.deepEqual(repository.releasedClaims, [
    repository.orphanObservation.findingId,
  ]);
  assert.equal(
    (repository.failed as { code?: string } | null)?.code,
    "DATABASE_RECONCILIATION_FAILED",
  );
});

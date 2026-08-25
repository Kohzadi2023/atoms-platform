import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  DATABASE_OPERATION_QUEUE_NAME,
  DATABASE_RECONCILIATION_QUEUE_NAME,
  DATABASE_RECONCILIATION_SCHEDULER_ID,
} from "@atoms/contracts";
import type {
  DatabaseConnectionScope,
  DatabaseHealthStatus,
  DatabaseProvider,
  DatabaseProvisionInput,
  DatabaseProvisionResult,
  ManagedDatabaseResource,
  SecretLease,
} from "@atoms/database-provider";
import { createPrismaClient, type PrismaClient } from "@atoms/db";
import { Queue } from "bullmq";

import { PrismaDatabaseReconciliationRepository } from "./database-reconciliation-repository.js";
import { BullMqDatabaseReconciliationWorker } from "./database-reconciliation-worker.js";
import { DatabaseReconciler } from "./database-reconciler.js";
import { BullMqDatabaseRecoveryQueue } from "./database-recovery-queue.js";

const integrationEnabled =
  process.env.RUN_PHASE3_DURABILITY_INTEGRATION_TESTS === "true";

test(
  "PostgreSQL and Redis integration applies migrations, fences stale work, and schedules one recovery",
  {
    skip: integrationEnabled
      ? false
      : "requires explicit Phase 3 durability integration opt-in with dedicated PostgreSQL and Redis",
    timeout: 60_000,
  },
  async () => {
    assert.equal(
      process.env.PHASE3_INTEGRATION_DATABASE_CONFIRMATION,
      "DEDICATED_EPHEMERAL_DATABASE",
      "integration test requires an explicitly dedicated ephemeral database",
    );
    const databaseUrl = requireEnvironment("DATABASE_URL");
    const redisUrl = requireEnvironment("REDIS_URL");
    const prisma = createPrismaClient(databaseUrl);
    const testStartedAt = new Date();
    const suffix = randomUUID().replaceAll("-", "");
    const prefix = `atoms-phase3-${suffix}`;
    const operationId = randomUUID();
    const externalId = `integration-${suffix.slice(0, 20)}`;
    const orphanExternalId = `orphan-${suffix.slice(0, 20)}`;
    const trackedName = `atoms-integration-${suffix.slice(0, 12)}`;
    const orphanName = `atoms-orphan-${suffix.slice(12, 24)}`;
    const repository = new PrismaDatabaseReconciliationRepository(prisma);
    const recoveryQueue = new BullMqDatabaseRecoveryQueue({ redisUrl, prefix });
    const provider = new IntegrationProvider([
      managedResource(externalId, trackedName),
      managedResource(orphanExternalId, orphanName),
    ]);
    const reconciler = new DatabaseReconciler({
      repository,
      provider,
      recoveryQueue,
      staleAfterMs: 60_000,
      orphanGraceMs: 60 * 60_000,
      abandonedSweepAfterMs: 5 * 60_000,
      maxRecoveryAttempts: 3,
      cleanupApprovedOrphans: false,
    });
    const operationQueue = new Queue(DATABASE_OPERATION_QUEUE_NAME, {
      connection: { url: redisUrl, maxRetriesPerRequest: 1 },
      prefix,
    });
    const reconciliationQueue = new Queue(DATABASE_RECONCILIATION_QUEUE_NAME, {
      connection: { url: redisUrl, maxRetriesPerRequest: 1 },
      prefix,
    });
    let worker: BullMqDatabaseReconciliationWorker | undefined;
    let workspaceId: string | undefined;

    try {
      await assertMigrationHistory(prisma);
      const fixture = await seedStaleDatabase(prisma, {
        suffix,
        operationId,
        externalId,
        trackedName,
      });
      workspaceId = fixture.workspaceId;

      const lockNow = new Date();
      const lockProbe = await Promise.all([
        repository.beginSweep({
          now: lockNow,
          staleBefore: new Date(lockNow.getTime() - 60_000),
          orphanGraceBefore: new Date(lockNow.getTime() - 60 * 60_000),
          abandonedSweepBefore: new Date(lockNow.getTime() - 5 * 60_000),
          dryRun: true,
        }),
        repository.beginSweep({
          now: lockNow,
          staleBefore: new Date(lockNow.getTime() - 60_000),
          orphanGraceBefore: new Date(lockNow.getTime() - 60 * 60_000),
          abandonedSweepBefore: new Date(lockNow.getTime() - 5 * 60_000),
          dryRun: true,
        }),
      ]);
      assert.deepEqual(
        lockProbe.map((result) => result.kind).sort(),
        ["locked", "started"],
      );
      const startedProbe = lockProbe.find((result) => result.kind === "started");
      assert.ok(startedProbe?.kind === "started");
      await repository.failSweep(
        startedProbe.sweepId,
        {
          code: "INTEGRATION_LOCK_PROBE_COMPLETE",
          message: "The partial unique index admitted exactly one sweep",
          retryable: false,
        },
        new Date(),
      );

      const scheduledAfter = new Date();
      const workerErrors: Error[] = [];
      worker = new BullMqDatabaseReconciliationWorker({
        redisUrl,
        reconciler,
        // Keep the scheduler realistic without allowing a second periodic
        // sweep to race the assertions for the first completed sweep.
        intervalMs: 5_000,
        prefix,
      });
      worker.onError((error) => workerErrors.push(error));
      await worker.start();

      const sweep = await waitFor(async () =>
        prisma.databaseReconciliationSweep.findFirst({
          where: {
            provider: "SUPABASE",
            status: "SUCCEEDED",
            startedAt: { gte: scheduledAfter },
          },
          orderBy: { startedAt: "asc" },
        }),
      );
      await worker.close();
      worker = undefined;

      assert.deepEqual(workerErrors, []);
      assert.equal(sweep.dryRun, true);
      assert.deepEqual(sweep.summary, {
        recoveredOperations: 1,
        exhaustedOperations: 0,
        missingResources: 0,
        orphanCandidates: 1,
        cleanedResources: 0,
      });

      const database = await prisma.databaseInstance.findUniqueOrThrow({
        where: { id: fixture.databaseInstanceId },
      });
      assert.equal(database.operationVersion, 1);
      assert.equal(database.recoveryCount, 1);
      assert.ok(database.lastReconciledAt instanceof Date);

      const recoveryJob = await operationQueue.getJob(
        `${operationId}-provision-v1`,
      );
      assert.ok(recoveryJob);
      assert.deepEqual(recoveryJob.data, {
        operationId,
        databaseInstanceId: fixture.databaseInstanceId,
        command: "provision",
        operationVersion: 1,
      });

      const orphanFinding =
        await prisma.databaseReconciliationFinding.findFirstOrThrow({
          where: {
            kind: "ORPHAN_PROVIDER_RESOURCE",
            externalId: orphanExternalId,
          },
        });
      assert.equal(orphanFinding.status, "OPEN");
      // Findings are durable across sweeps and their sweepId advances to the
      // latest observation, so the assertion must not depend on a transient
      // scheduler tick boundary.
      assert.ok(orphanFinding.observationCount >= 1);
      assert.ok(orphanFinding.lastSeenAt >= scheduledAfter);
      assert.equal(provider.destroyCalls, 0);

      const event = await prisma.runEvent.findFirstOrThrow({
        where: { runId: fixture.runId, eventType: "integration.status_changed" },
        orderBy: { sequence: "desc" },
      });
      assert.equal(
        (event.payload as { operationVersion?: unknown }).operationVersion,
        1,
      );
      const serializedEvent = JSON.stringify(event.payload);
      assert.ok(!/postgres(?:ql)?:\/\//iu.test(serializedEvent));
    } finally {
      await worker?.close().catch(() => undefined);
      await reconciliationQueue
        .removeJobScheduler(DATABASE_RECONCILIATION_SCHEDULER_ID)
        .catch(() => false);
      await operationQueue.obliterate({ force: true }).catch(() => undefined);
      await reconciliationQueue.obliterate({ force: true }).catch(() => undefined);
      await operationQueue.close().catch(() => undefined);
      await reconciliationQueue.close().catch(() => undefined);
      await recoveryQueue.close().catch(() => undefined);
      if (workspaceId !== undefined) {
        await prisma.workspace.deleteMany({ where: { id: workspaceId } });
      }
      const testSweeps = await prisma.databaseReconciliationSweep.findMany({
        where: { startedAt: { gte: testStartedAt } },
        select: { id: true },
      });
      const sweepIds = testSweeps.map((sweep) => sweep.id);
      if (sweepIds.length > 0) {
        await prisma.databaseReconciliationFinding.deleteMany({
          where: { sweepId: { in: sweepIds } },
        });
        await prisma.databaseReconciliationSweep.deleteMany({
          where: { id: { in: sweepIds } },
        });
      }
      await prisma.$disconnect();
    }
  },
);

class IntegrationProvider implements DatabaseProvider {
  readonly name = "SUPABASE" as const;
  destroyCalls = 0;

  constructor(readonly resources: readonly ManagedDatabaseResource[]) {}

  provision(_input: DatabaseProvisionInput): Promise<DatabaseProvisionResult> {
    throw new Error("provision is outside this reconciliation integration test");
  }

  async listManagedResources(): Promise<readonly ManagedDatabaseResource[]> {
    return this.resources;
  }

  getHealth(_externalId: string): Promise<DatabaseHealthStatus> {
    throw new Error("health is outside this reconciliation integration test");
  }

  getEphemeralConnection(
    _externalId: string,
    _scope: DatabaseConnectionScope,
    _connectionSecretRef: string,
  ): Promise<SecretLease> {
    throw new Error("connection leases are outside this reconciliation integration test");
  }

  async destroy(_externalId: string): Promise<void> {
    this.destroyCalls += 1;
  }
}

async function assertMigrationHistory(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<
    ReadonlyArray<{
      readonly migration_name: string;
      readonly finished_at: Date | null;
      readonly rolled_back_at: Date | null;
    }>
  >`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name`;
  const applied = new Map(rows.map((row) => [row.migration_name, row]));
  for (const migrationName of [
    "20260731140000_contract_sprint_init",
    "20260801150000_phase2_validation_preview",
    "20260801190000_phase3_david_database_provisioning",
    "20260801220000_phase3_database_reconciliation",
  ]) {
    const row = applied.get(migrationName);
    assert.ok(row, `missing migration ${migrationName}`);
    assert.ok(row.finished_at instanceof Date);
    assert.equal(row.rolled_back_at, null);
  }
}

async function seedStaleDatabase(
  prisma: PrismaClient,
  input: {
    readonly suffix: string;
    readonly operationId: string;
    readonly externalId: string;
    readonly trackedName: string;
  },
): Promise<{
  readonly workspaceId: string;
  readonly runId: string;
  readonly databaseInstanceId: string;
}> {
  const workspace = await prisma.workspace.create({
    data: { name: "Phase 3 integration", slug: `phase3-${input.suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Phase 3 integration",
      slug: `phase3-${input.suffix}`,
    },
  });
  const run = await prisma.agentRun.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      status: "COMPLETED",
      prompt: "Phase 3 durability integration fixture",
      completedAt: new Date(),
    },
  });
  const task = await prisma.agentTask.create({
    data: {
      runId: run.id,
      agentName: "David",
      description: "Generate staging migration fixture",
      status: "COMPLETED",
      ordinal: 5,
      completedAt: new Date(),
    },
  });
  const artifact = await prisma.migrationArtifact.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      sourceRunId: run.id,
      agentTaskId: task.id,
      status: "VALIDATED",
      schemaPath: "prisma/schema.prisma",
      schemaHash: "a".repeat(64),
      migrationPaths: ["prisma/migrations/20260801_init/migration.sql"],
      seedPath: "prisma/seed.ts",
      destructive: false,
      policyReport: { summary: "integration fixture" },
    },
  });
  const database = await prisma.databaseInstance.create({
    data: {
      operationId: input.operationId,
      workspaceId: workspace.id,
      projectId: project.id,
      migrationArtifactId: artifact.id,
      provider: "SUPABASE",
      externalId: input.externalId,
      idempotencyKey: `phase3-${input.suffix}`,
      displayName: input.trackedName,
      databaseName: "postgres",
      region: "americas",
      status: "MIGRATING",
      operationVersion: 0,
      recoveryCount: 0,
      lastHeartbeatAt: new Date(Date.now() - 10 * 60_000),
    },
  });
  return {
    workspaceId: workspace.id,
    runId: run.id,
    databaseInstanceId: database.id,
  };
}

function managedResource(
  externalId: string,
  name: string,
): ManagedDatabaseResource {
  return {
    externalId,
    name,
    region: "americas",
    status: "ACTIVE_HEALTHY",
    createdAt: new Date().toISOString(),
  };
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the scheduled reconciliation sweep");
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.length > 0, `${name} is required`);
  return value;
}

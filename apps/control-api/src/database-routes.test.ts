import assert from "node:assert/strict";
import test from "node:test";

import type {
  CreateProjectInput,
  DatabaseActionInput,
  DatabaseOperationJob,
  FileContentInput,
  JsonValue,
  ProvisionDatabaseInput,
} from "@atoms/contracts";

import { buildControlApi } from "./app.js";
import type {
  DatabaseInstanceRecord,
  MigrationArtifactRecord,
} from "./database-domain.js";
import type { DatabaseOperationQueue } from "./database-operation-queue.js";
import type {
  CreateDatabaseOperationResult,
  DatabaseControlRepository,
  DestroyDatabaseOperationResult,
} from "./database-repository.js";
import type { ControlRepository, PutProjectFileResult } from "./repository.js";
import type { CreateRunWithIdempotencyResult } from "./repository.js";
import type { RunQueue } from "./run-queue.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const DATABASE_ID = "00000000-0000-4000-8000-000000000003";
const OPERATION_ID = "00000000-0000-4000-8000-000000000004";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000005";
const FIXED_NOW = new Date("2026-08-01T21:00:00.000Z");

const database: DatabaseInstanceRecord = {
  id: DATABASE_ID,
  operationId: OPERATION_ID,
  workspaceId: WORKSPACE_ID,
  projectId: PROJECT_ID,
  migrationArtifactId: ARTIFACT_ID,
  provider: "SUPABASE",
  externalId: null,
  displayName: "Customer Portal",
  databaseName: null,
  region: "americas",
  status: "QUEUED",
  operationVersion: 0,
  attempt: 0,
  recoveryCount: 0,
  error: null,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
  lastHeartbeatAt: FIXED_NOW,
  lastSyncedAt: null,
  readyAt: null,
  deletedAt: null,
};

const migrationArtifact: MigrationArtifactRecord = {
  id: ARTIFACT_ID,
  workspaceId: WORKSPACE_ID,
  projectId: PROJECT_ID,
  sourceRunId: "00000000-0000-4000-8000-000000000006",
  schemaPath: "prisma/schema.prisma",
  schemaHash: "a".repeat(64),
  migrationPaths: ["prisma/migrations/20260801_init/migration.sql"],
  seedPath: "prisma/seed.ts",
  destructive: false,
  policyReport: { findings: [] },
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
};

class NoopControlRepository implements ControlRepository {
  async createProject(_input: CreateProjectInput): Promise<never> {
    throw new Error("not used");
  }
  async getProject(): Promise<null> {
    return null;
  }
  async createRun(): Promise<null> {
    return null;
  }
  async createRunWithIdempotency(): Promise<CreateRunWithIdempotencyResult> {
    return { kind: "project_not_found" };
  }
  async getRun(): Promise<null> {
    return null;
  }
  async transitionRun(): Promise<null> {
    return null;
  }
  async markRunFailed(
    _runId: string,
    _expectedControlVersion: number,
    _error: JsonValue,
  ): Promise<void> {}
  async listRunEventsAfter(): Promise<[]> {
    return [];
  }
  async listProjectFiles(): Promise<null> {
    return null;
  }
  async getProjectFile(): Promise<null> {
    return null;
  }
  async putProjectFile(
    _projectId: string,
    _input: FileContentInput,
  ): Promise<PutProjectFileResult> {
    return { kind: "project_not_found" };
  }
  async close(): Promise<void> {}
}

class NoopRunQueue implements RunQueue {
  async enqueue(): Promise<void> {}
  async close(): Promise<void> {}
}

class MemoryDatabaseRepository implements DatabaseControlRepository {
  createResult: CreateDatabaseOperationResult = {
    kind: "ok",
    database,
    replayed: false,
  };

  async createDatabaseOperation(
    _projectId: string,
    _idempotencyKey: string,
    _input: ProvisionDatabaseInput,
  ): Promise<CreateDatabaseOperationResult> {
    return this.createResult;
  }

  async getDatabaseInstance(): Promise<DatabaseInstanceRecord | null> {
    return database;
  }

  async getLatestMigrationArtifact(): Promise<MigrationArtifactRecord> {
    return migrationArtifact;
  }

  async requestDatabaseAction(
    _projectId: string,
    _databaseInstanceId: string,
    _input: DatabaseActionInput,
  ): Promise<DestroyDatabaseOperationResult> {
    return {
      kind: "ok",
      database: { ...database, status: "DELETING" },
    };
  }

  async markDatabaseOperationFailed(): Promise<void> {}
}

class MemoryDatabaseQueue implements DatabaseOperationQueue {
  readonly jobs: DatabaseOperationJob[] = [];
  async enqueue(job: DatabaseOperationJob): Promise<void> {
    this.jobs.push(job);
  }
  async close(): Promise<void> {}
}

async function fixture() {
  const repository = new MemoryDatabaseRepository();
  const queue = new MemoryDatabaseQueue();
  const app = await buildControlApi({
    repository: new NoopControlRepository(),
    runQueue: new NoopRunQueue(),
    databaseOperations: { repository, queue },
    now: () => FIXED_NOW,
  });
  return { app, repository, queue };
}

test("database provisioning requires confirmation and enqueues a deterministic operation", async () => {
  const { app, queue } = await fixture();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/databases`,
      headers: { "idempotency-key": "provision-customer-portal-v1" },
      payload: {
        provider: "SUPABASE",
        region: "americas",
        migrationArtifactId: ARTIFACT_ID,
        approveDestructiveChanges: false,
        confirmation: "PROVISION_DATABASE",
      },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().status, "QUEUED");
    assert.deepEqual(queue.jobs, [
      {
        operationId: OPERATION_ID,
        databaseInstanceId: DATABASE_ID,
        command: "provision",
        operationVersion: 0,
      },
    ]);

    const missingConfirmation = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/databases`,
      headers: { "idempotency-key": "another-operation-key" },
      payload: {
        provider: "SUPABASE",
        region: "americas",
        migrationArtifactId: ARTIFACT_ID,
      },
    });
    assert.equal(missingConfirmation.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("latest David migration artifact is discoverable without exposing secrets", async () => {
  const { app } = await fixture();
  try {
    const response = await app.inject({
      method: "GET",
      url: `/v1/projects/${PROJECT_ID}/migration-artifacts/latest`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().id, ARTIFACT_ID);
    assert.equal(response.json().schemaHash, "a".repeat(64));
    assert.ok(!JSON.stringify(response.json()).includes("connection"));
  } finally {
    await app.close();
  }
});

test("destructive schema diffs are blocked until explicitly approved", async () => {
  const { app, repository, queue } = await fixture();
  repository.createResult = { kind: "destructive_approval_required" };
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/databases`,
      headers: { "idempotency-key": "destructive-operation-key" },
      payload: {
        provider: "SUPABASE",
        region: "americas",
        migrationArtifactId: ARTIFACT_ID,
        approveDestructiveChanges: false,
        confirmation: "PROVISION_DATABASE",
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json().error.code,
      "DESTRUCTIVE_MIGRATION_APPROVAL_REQUIRED",
    );
    assert.equal(queue.jobs.length, 0);
  } finally {
    await app.close();
  }
});

test("database destruction requires the exact destructive confirmation", async () => {
  const { app, queue } = await fixture();
  try {
    const invalid = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/actions`,
      payload: { action: "destroy", confirmation: "yes" },
    });
    assert.equal(invalid.statusCode, 400);

    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/actions`,
      payload: { action: "destroy", confirmation: "DESTROY_DATABASE" },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().status, "DELETING");
    assert.equal(queue.jobs.at(-1)?.command, "destroy");
  } finally {
    await app.close();
  }
});

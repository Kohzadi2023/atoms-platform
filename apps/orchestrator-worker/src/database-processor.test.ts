import assert from "node:assert/strict";
import test from "node:test";

import type { AgentProjectFile } from "@atoms/agents";
import type {
  DatabaseOperationJob,
  JsonValue,
} from "@atoms/contracts";
import {
  InMemorySecretStore,
  type DatabaseHealthStatus,
  type DatabaseMigrationInput,
  type DatabaseMigrationResult,
  type DatabaseMigrationRunner,
  type DatabaseProvider,
  type DatabaseProvisionInput,
  type DatabaseProvisionResult,
  type SecretLease,
} from "@atoms/database-provider";

import type {
  DatabaseClaimResult,
  DatabaseExecutionRecord,
  DatabaseOperationRepository,
} from "./database-domain.js";
import { DatabaseOperationProcessor } from "./database-processor.js";

const DATABASE_ID = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "00000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000003";
const PROJECT_ID = "00000000-0000-4000-8000-000000000004";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000005";
const RUN_ID = "00000000-0000-4000-8000-000000000006";
const FIXED_NOW = new Date("2026-08-01T20:00:00.000Z");

const database: DatabaseExecutionRecord = {
  id: DATABASE_ID,
  operationId: OPERATION_ID,
  workspaceId: WORKSPACE_ID,
  projectId: PROJECT_ID,
  displayName: "Customer Portal",
  region: "americas",
  provider: "SUPABASE",
  externalId: null,
  connectionSecretRef: null,
  status: "PROVISIONING",
  operationVersion: 0,
  migrationArtifact: {
    id: ARTIFACT_ID,
    sourceRunId: RUN_ID,
    schemaHash: "a".repeat(64),
    destructive: false,
  },
};

class MemoryDatabaseRepository implements DatabaseOperationRepository {
  readonly transitions: string[] = [];
  failure: JsonValue | null = null;
  claimDatabase: DatabaseExecutionRecord = database;
  healthHeartbeatAccepted = true;

  async claim(_job: DatabaseOperationJob): Promise<DatabaseClaimResult> {
    return { kind: "ready", database: this.claimDatabase };
  }

  async recordProvisioned(
    _database: DatabaseExecutionRecord,
    _result: DatabaseProvisionResult,
  ): Promise<boolean> {
    this.transitions.push("HEALTH_CHECK");
    return true;
  }

  async recordHealthCheck(
    _database: DatabaseExecutionRecord,
    message: string,
  ): Promise<boolean> {
    this.transitions.push(message);
    return this.healthHeartbeatAccepted;
  }

  async startMigration(): Promise<boolean> {
    this.transitions.push("MIGRATING");
    return true;
  }

  async listProjectFiles(): Promise<readonly AgentProjectFile[]> {
    return [
      { path: "package.json", content: "{}", version: 1 },
      { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'", version: 1 },
      {
        path: "prisma/schema.prisma",
        content: "model User { id String @id }",
        version: 1,
      },
      {
        path: "prisma/migrations/20260801_init/migration.sql",
        content: "CREATE TABLE users (id text primary key);",
        version: 1,
      },
    ];
  }

  async completeMigration(): Promise<boolean> {
    this.transitions.push("READY");
    return true;
  }

  async completeDestroy(): Promise<boolean> {
    this.transitions.push("DELETED");
    return true;
  }

  async fail(
    _database: DatabaseExecutionRecord,
    error: JsonValue,
  ): Promise<void> {
    this.failure = error;
  }
}

class FakeProvider implements DatabaseProvider {
  readonly name = "SUPABASE" as const;
  readonly secretStore: InMemorySecretStore;
  healthChecks = 0;
  destroyed = 0;

  constructor(secretStore: InMemorySecretStore) {
    this.secretStore = secretStore;
  }

  async provision(_input: DatabaseProvisionInput): Promise<DatabaseProvisionResult> {
    const connectionSecretRef = await this.secretStore.put(
      "databases/test/connection",
      "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
    );
    return {
      externalId: "abcdefghijklmnopqrst",
      databaseName: "postgres",
      region: "americas",
      connectionSecretRef,
      providerOperationMetadata: { reconciled: "false" },
    };
  }

  async listManagedResources(): Promise<[]> {
    return [];
  }

  async getHealth(): Promise<DatabaseHealthStatus> {
    this.healthChecks += 1;
    return {
      state: this.healthChecks === 1 ? "PROVISIONING" : "HEALTHY",
      services: [],
    };
  }

  getEphemeralConnection(
    _externalId: string,
    scope: "migrate" | "runtime",
    connectionSecretRef: string,
  ): Promise<SecretLease> {
    return this.secretStore.createLease(connectionSecretRef, scope, 60_000);
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
  }
}

class FakeMigrationRunner implements DatabaseMigrationRunner {
  calls = 0;

  async migrate(input: DatabaseMigrationInput): Promise<DatabaseMigrationResult> {
    this.calls += 1;
    assert.match(input.connectionUrl, /^postgresql:\/\//);
    return { steps: [] };
  }
}

function provisionJob(): DatabaseOperationJob {
  return {
    operationId: OPERATION_ID,
    databaseInstanceId: DATABASE_ID,
    command: "provision",
    operationVersion: 0,
  };
}

test("database processor completes provision, health, migrate, seed, and connect flow", async () => {
  const repository = new MemoryDatabaseRepository();
  const secretStore = new InMemorySecretStore({ now: () => FIXED_NOW });
  const provider = new FakeProvider(secretStore);
  const migrationRunner = new FakeMigrationRunner();
  const processor = new DatabaseOperationProcessor({
    repository,
    provider,
    secretStore,
    migrationRunner,
    healthAttempts: 3,
    healthIntervalMs: 1,
    delay: async () => undefined,
    now: () => FIXED_NOW,
  });

  assert.deepEqual(
    await processor.process(provisionJob(), { attempt: 1, maxAttempts: 3 }),
    { outcome: "completed" },
  );
  assert.equal(provider.healthChecks, 2);
  assert.equal(migrationRunner.calls, 1);
  assert.deepEqual(repository.transitions, [
    "HEALTH_CHECK",
    "Health poll 1: PROVISIONING",
    "Health poll 2: HEALTHY",
    "MIGRATING",
    "READY",
  ]);
  assert.equal(repository.failure, null);
});

test("database processor destroys provider resource only after the queued action", async () => {
  const repository = new MemoryDatabaseRepository();
  repository.claimDatabase = {
    ...database,
    status: "DELETING",
    externalId: "abcdefghijklmnopqrst",
  };
  const secretStore = new InMemorySecretStore({ now: () => FIXED_NOW });
  const provider = new FakeProvider(secretStore);
  const processor = new DatabaseOperationProcessor({
    repository,
    provider,
    secretStore,
    migrationRunner: new FakeMigrationRunner(),
    now: () => FIXED_NOW,
  });

  assert.deepEqual(
    await processor.process(
      { ...provisionJob(), command: "destroy" },
      { attempt: 1, maxAttempts: 3 },
    ),
    { outcome: "completed" },
  );
  assert.equal(provider.destroyed, 1);
});

test("operation-version fencing stops a stale worker at its next heartbeat", async () => {
  const repository = new MemoryDatabaseRepository();
  repository.healthHeartbeatAccepted = false;
  const secretStore = new InMemorySecretStore({ now: () => FIXED_NOW });
  const provider = new FakeProvider(secretStore);
  const migrationRunner = new FakeMigrationRunner();
  const processor = new DatabaseOperationProcessor({
    repository,
    provider,
    secretStore,
    migrationRunner,
    now: () => FIXED_NOW,
  });

  assert.deepEqual(
    await processor.process(provisionJob(), { attempt: 1, maxAttempts: 3 }),
    { outcome: "skipped", reason: "stale" },
  );
  assert.equal(migrationRunner.calls, 0);
  assert.equal(repository.failure, null);
});

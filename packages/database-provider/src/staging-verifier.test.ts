import assert from "node:assert/strict";
import test from "node:test";

import type {
  DatabaseMigrationInput,
  DatabaseMigrationResult,
  DatabaseMigrationRunner,
  DatabaseMigrationStepReport,
  DatabaseMigrationStepName,
} from "./migration-runner.js";
import { DatabaseMigrationError } from "./errors.js";
import { InMemorySecretStore } from "./secret-store.js";
import { runPhase3ProviderStagingScenario } from "./staging-verifier.js";
import type {
  DatabaseConnectionScope,
  DatabaseHealthStatus,
  DatabaseProvider,
  DatabaseProvisionInput,
  DatabaseProvisionResult,
  ManagedDatabaseResource,
  SecretLease,
} from "./types.js";

const FIXED_NOW = new Date("2026-08-01T23:00:00.000Z");
const SCENARIO_ID = "00000000-0000-4000-8000-000000000101";
const PROJECT_ID = "00000000-0000-4000-8000-000000000102";
const CONNECTION_URL =
  "postgresql://postgres:sensitive@db.generated-ref.supabase.co:5432/postgres?sslmode=require";
const fixtureFiles = [
  { path: "package.json", content: "{}" },
  { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'" },
  { path: "prisma/schema.prisma", content: "datasource db { provider = \"postgresql\" }" },
  {
    path: "prisma/migrations/20260801_init/migration.sql",
    content: "CREATE TABLE evidence (id text primary key);",
  },
];

class StagingProvider implements DatabaseProvider {
  readonly name = "SUPABASE" as const;
  readonly resources = new Map<string, ManagedDatabaseResource>();
  listCalls = 0;
  destroyCalls = 0;

  constructor(
    readonly secretStore: InMemorySecretStore,
    preexisting = false,
  ) {
    this.resources.set("control-resource", {
      externalId: "control-resource",
      name: "atoms-control-aaaaaaaaaaaa",
      region: "americas",
      status: "ACTIVE_HEALTHY",
      createdAt: FIXED_NOW.toISOString(),
    });
    if (preexisting) this.resources.set("generated-ref", generatedResource());
  }

  async provision(_input: DatabaseProvisionInput): Promise<DatabaseProvisionResult> {
    this.resources.set("generated-ref", generatedResource());
    const connectionSecretRef = await this.secretStore.put(
      "databases/generated-ref/connection",
      CONNECTION_URL,
    );
    return {
      externalId: "generated-ref",
      databaseName: "postgres",
      region: "americas",
      connectionSecretRef,
      providerOperationMetadata: { reconciled: "false" },
    };
  }

  async listManagedResources(): Promise<readonly ManagedDatabaseResource[]> {
    this.listCalls += 1;
    return [...this.resources.values()];
  }

  async getHealth(_externalId: string): Promise<DatabaseHealthStatus> {
    return { state: "HEALTHY", services: [{ name: "database", status: "ACTIVE_HEALTHY" }] };
  }

  getEphemeralConnection(
    _externalId: string,
    scope: DatabaseConnectionScope,
    connectionSecretRef: string,
  ): Promise<SecretLease> {
    return this.secretStore.createLease(connectionSecretRef, scope, 60_000);
  }

  async destroy(_externalId: string, connectionSecretRef?: string): Promise<void> {
    this.destroyCalls += 1;
    this.resources.delete("generated-ref");
    if (connectionSecretRef !== undefined) {
      await this.secretStore.revoke(connectionSecretRef);
    }
  }
}

class StagingMigrationRunner implements DatabaseMigrationRunner {
  constructor(readonly failAt?: DatabaseMigrationStepName) {}

  async migrate(input: DatabaseMigrationInput): Promise<DatabaseMigrationResult> {
    const steps: DatabaseMigrationStepReport[] = [];
    for (const [index, name] of [
      "install",
      "migrate",
      "seed",
      "connectivity",
    ].entries()) {
      const typedName = name as DatabaseMigrationStepName;
      const exitCode = typedName === this.failAt ? 1 : 0;
      const step = {
        ordinal: index + 1,
        name: typedName,
        command: `fixed-${typedName}`,
        startedAt: FIXED_NOW.toISOString(),
        completedAt: FIXED_NOW.toISOString(),
        result: {
          exitCode,
          stdout: input.connectionUrl,
          stderr: "",
          durationMs: 1,
        },
      };
      steps.push(step);
      await input.onStep?.(step);
      if (exitCode !== 0) throw new DatabaseMigrationError(typedName, exitCode);
    }
    return { steps };
  }
}

test("provider staging scenario emits complete redacted evidence and restores inventory", async () => {
  const secretStore = new InMemorySecretStore({ now: () => FIXED_NOW });
  const provider = new StagingProvider(secretStore);
  const evidence = await runPhase3ProviderStagingScenario({
    provider,
    secretStore,
    migrationRunner: new StagingMigrationRunner(),
    fixtureFiles,
    changeTicket: "CHG-3001",
    measuredVariableCostCadMicros: 900_000,
    scenarioId: SCENARIO_ID,
    projectId: PROJECT_ID,
    now: () => FIXED_NOW,
  });

  assert.equal(evidence.result, "PASSED");
  assert.equal(evidence.createdResources, 1);
  assert.equal(evidence.deletedResources, 1);
  assert.equal(evidence.managedResourcesBefore, 1);
  assert.equal(evidence.managedResourcesAfter, 1);
  assert.equal(provider.destroyCalls, 1);
  assert.ok(evidence.gates.every((gate) => gate.status === "PASSED"));
  assert.ok(!JSON.stringify(evidence).includes(CONNECTION_URL));
  assert.ok(!JSON.stringify(evidence).includes("sensitive"));
});

test("provider staging scenario cleans up after migration failure", async () => {
  const secretStore = new InMemorySecretStore({ now: () => FIXED_NOW });
  const provider = new StagingProvider(secretStore);
  const evidence = await runPhase3ProviderStagingScenario({
    provider,
    secretStore,
    migrationRunner: new StagingMigrationRunner("migrate"),
    fixtureFiles,
    changeTicket: "CHG-3002",
    measuredVariableCostCadMicros: 900_000,
    scenarioId: SCENARIO_ID,
    projectId: PROJECT_ID,
    now: () => FIXED_NOW,
  });

  assert.equal(evidence.result, "FAILED");
  assert.equal(evidence.deletedResources, 1);
  assert.equal(provider.destroyCalls, 1);
  assert.equal(
    evidence.gates.find((gate) => gate.name === "provider_cleanup")?.status,
    "PASSED",
  );
  assert.ok(
    evidence.errors.some((error) => error.code === "DATABASE_MIGRATION_FAILED"),
  );
});

test("provider staging scenario never deletes a resource that predated the run", async () => {
  const secretStore = new InMemorySecretStore({ now: () => FIXED_NOW });
  const provider = new StagingProvider(secretStore, true);
  const evidence = await runPhase3ProviderStagingScenario({
    provider,
    secretStore,
    migrationRunner: new StagingMigrationRunner(),
    fixtureFiles,
    changeTicket: "CHG-3003",
    measuredVariableCostCadMicros: 900_000,
    scenarioId: SCENARIO_ID,
    projectId: PROJECT_ID,
    now: () => FIXED_NOW,
  });

  assert.equal(evidence.result, "FAILED");
  assert.equal(evidence.createdResources, 0);
  assert.equal(evidence.deletedResources, 0);
  assert.equal(provider.destroyCalls, 0);
  assert.ok(provider.resources.has("generated-ref"));
});

test("provider staging scenario rejects an over-budget run before provider access", async () => {
  const secretStore = new InMemorySecretStore({ now: () => FIXED_NOW });
  const provider = new StagingProvider(secretStore);
  const evidence = await runPhase3ProviderStagingScenario({
    provider,
    secretStore,
    migrationRunner: new StagingMigrationRunner(),
    fixtureFiles,
    changeTicket: "CHG-3004",
    measuredVariableCostCadMicros: 4_000_001,
    scenarioId: SCENARIO_ID,
    projectId: PROJECT_ID,
    now: () => FIXED_NOW,
  });

  assert.equal(evidence.result, "FAILED");
  assert.equal(provider.listCalls, 0);
  assert.equal(provider.destroyCalls, 0);
  assert.equal(evidence.createdResources, 0);
});

test("provider staging scenario records approved custom cleanup and falls back safely on failure", async () => {
  const approvedSecretStore = new InMemorySecretStore({ now: () => FIXED_NOW });
  const approvedProvider = new StagingProvider(approvedSecretStore);
  const approved = await runPhase3ProviderStagingScenario({
    provider: approvedProvider,
    secretStore: approvedSecretStore,
    migrationRunner: new StagingMigrationRunner(),
    fixtureFiles,
    changeTicket: "CHG-3005",
    measuredVariableCostCadMicros: 900_000,
    scenarioId: SCENARIO_ID,
    projectId: PROJECT_ID,
    now: () => FIXED_NOW,
    cleanupOwnedResource: async ({ externalId, connectionSecretRef }) => {
      await approvedProvider.destroy(externalId, connectionSecretRef);
      return { strategy: "approval_gated_orphan_reconciliation" };
    },
  });
  assert.equal(approved.result, "PASSED");
  assert.ok(
    JSON.stringify(
      approved.gates.find((gate) => gate.name === "provider_cleanup")?.details,
    ).includes("approval_gated_orphan_reconciliation"),
  );

  const fallbackSecretStore = new InMemorySecretStore({ now: () => FIXED_NOW });
  const fallbackProvider = new StagingProvider(fallbackSecretStore);
  const fallback = await runPhase3ProviderStagingScenario({
    provider: fallbackProvider,
    secretStore: fallbackSecretStore,
    migrationRunner: new StagingMigrationRunner(),
    fixtureFiles,
    changeTicket: "CHG-3006",
    measuredVariableCostCadMicros: 900_000,
    scenarioId: SCENARIO_ID,
    projectId: PROJECT_ID,
    now: () => FIXED_NOW,
    cleanupOwnedResource: async () => {
      throw new Error("approved cleanup path failed");
    },
  });
  assert.equal(fallback.result, "FAILED");
  assert.equal(fallback.deletedResources, 1);
  assert.equal(fallbackProvider.destroyCalls, 1);
  assert.equal(fallback.managedResourcesAfter, fallback.managedResourcesBefore);
});

function generatedResource(): ManagedDatabaseResource {
  return {
    externalId: "generated-ref",
    name: "atoms-phase-3-staging-000000000000",
    region: "americas",
    status: "ACTIVE_HEALTHY",
    createdAt: FIXED_NOW.toISOString(),
  };
}

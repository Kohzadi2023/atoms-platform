import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExecCommand,
  ExecResult,
  PreviewUrl,
  SandboxFileInput,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from "@atoms/sandbox-provider";

import {
  E2BDatabaseMigrationRunner,
  InMemorySecretStore,
  SupabaseDatabaseProvider,
  VaultSecretStore,
} from "./index.js";

const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const FIXED_NOW = new Date("2026-08-01T19:00:00.000Z");

test("Supabase adapter provisions once, reconciles retries, and keeps credentials opaque", async () => {
  const secretStore = new InMemorySecretStore({ now: () => FIXED_NOW });
  const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  let created = false;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    if (url.endsWith("/v1/projects") && init?.method === "GET") {
      return Response.json(
        created
          ? [
              {
                id: "abcdefghijklmnopqrst",
                name: "atoms-customer-portal-000000000000",
                organization_slug: "atoms-org",
                region: "americas",
                status: "ACTIVE_HEALTHY",
                created_at: "2026-08-01T18:00:00.000Z",
              },
              {
                id: "unmanaged-project-ref",
                name: "customer-owned-project",
                organization_slug: "atoms-org",
                region: "americas",
                status: "ACTIVE_HEALTHY",
              },
              {
                id: "other-org-managed-project",
                name: "atoms-other-org-222222222222",
                organization_slug: "other-org",
                region: "americas",
                status: "ACTIVE_HEALTHY",
              },
            ]
          : [],
      );
    }
    if (url.endsWith("/v1/projects") && init?.method === "POST") {
      created = true;
      return Response.json({
        id: "abcdefghijklmnopqrst",
        name: "atoms-customer-portal-000000000000",
        region: "americas",
        status: "COMING_UP",
      });
    }
    if (url.endsWith("/health")) {
      return Response.json([
        { name: "database", status: "ACTIVE_HEALTHY" },
        { name: "auth", status: "ACTIVE_HEALTHY" },
      ]);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const provider = new SupabaseDatabaseProvider({
    accessToken: "provider-token-must-never-appear",
    organizationSlug: "atoms-org",
    secretStore,
    fetch: fakeFetch,
  });
  const input = {
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    displayName: "Customer Portal",
    region: "americas",
  } as const;

  const first = await provider.provision(input);
  const second = await provider.provision(input);
  assert.equal(first.externalId, "abcdefghijklmnopqrst");
  assert.equal(second.externalId, first.externalId);
  assert.equal(
    calls.filter((call) => call.init?.method === "POST").length,
    1,
  );
  assert.ok(!JSON.stringify(first).includes("postgresql://"));
  assert.ok(!JSON.stringify(first).includes("provider-token"));
  assert.deepEqual(await provider.listManagedResources(), [
    {
      externalId: "abcdefghijklmnopqrst",
      name: "atoms-customer-portal-000000000000",
      region: "americas",
      status: "ACTIVE_HEALTHY",
      createdAt: "2026-08-01T18:00:00.000Z",
    },
  ]);
  assert.deepEqual(await provider.auditManagedInventoryScope(), {
    visibleProjects: 3,
    configuredOrganizationProjects: 2,
    managedResources: 1,
    excludedOtherOrganizationProjects: 1,
    excludedUnmanagedInConfiguredOrganization: 1,
    missingOrganizationAttribution: 0,
  });
  assert.equal((await provider.getHealth(first.externalId)).state, "HEALTHY");

  const lease = await provider.getEphemeralConnection(
    first.externalId,
    "migrate",
    first.connectionSecretRef,
  );
  assert.match(await secretStore.get(lease.reference), /^postgresql:\/\//);
});

test("Vault adapter uses KV v2 and never includes the token in errors", async () => {
  const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    if (init?.method === "POST") return Response.json({ data: {} });
    if (init?.method === "GET") {
      return Response.json({ data: { data: { value: "secret-value" } } });
    }
    return new Response(null, { status: 204 });
  };
  const store = new VaultSecretStore({
    address: "https://vault.example.com",
    token: "vault-token-sensitive",
    mount: "atoms",
    fetch: fakeFetch,
    now: () => FIXED_NOW,
  });
  const reference = await store.put("databases/test/connection", "secret-value");
  assert.equal(reference, "vault://atoms/databases/test/connection");
  assert.equal(await store.get(reference), "secret-value");
  await store.revoke(reference);
  assert.equal(requests.length, 3);
  assert.ok(!JSON.stringify(requests.map((request) => request.url)).includes("vault-token"));
});

class FakeSandboxProvider implements SandboxProvider {
  readonly specs: SandboxSpec[] = [];
  readonly commands: ExecCommand[] = [];
  terminated = 0;
  connectionUrl = "";

  async create(input: SandboxSpec): Promise<SandboxHandle> {
    this.specs.push(input);
    this.connectionUrl = input.envs?.DATABASE_URL ?? "";
    return {
      id: "sandbox-1",
      provider: "e2b",
      createdAt: FIXED_NOW.toISOString(),
    };
  }

  async writeFiles(_id: string, _files: readonly SandboxFileInput[]): Promise<void> {}

  async exec(_id: string, command: ExecCommand): Promise<ExecResult> {
    this.commands.push(command);
    return {
      exitCode: 0,
      stdout: `connected with ${this.connectionUrl}`,
      stderr: "",
      durationMs: 1,
    };
  }

  async startProcess(): Promise<{ readonly pid: number }> {
    throw new Error("not used");
  }

  async exposePort(): Promise<PreviewUrl> {
    throw new Error("not used");
  }

  async terminate(): Promise<void> {
    this.terminated += 1;
  }
}

test("migration runner uses fixed commands, database-only egress, and redacted reports", async () => {
  const sandbox = new FakeSandboxProvider();
  const runner = new E2BDatabaseMigrationRunner({
    provider: sandbox,
    now: () => FIXED_NOW,
  });
  const connectionUrl =
    "postgresql://postgres:super-secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=require";
  const result = await runner.migrate({
    files: [
      { path: "package.json", content: "{}" },
      { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'" },
      { path: "prisma/schema.prisma", content: "model User { id String @id }" },
      {
        path: "prisma/migrations/202608011900_init/migration.sql",
        content: "CREATE TABLE users (id text primary key);",
      },
    ],
    connectionUrl,
    metadata: { projectId: PROJECT_ID },
  });

  assert.deepEqual(
    sandbox.commands.map((command) => command.command),
    [
      "pnpm install --frozen-lockfile",
      "pnpm exec prisma migrate deploy",
      "pnpm exec prisma db seed",
      "pnpm exec prisma migrate status",
    ],
  );
  assert.deepEqual(sandbox.specs[0]?.network?.allowedHosts, [
    "registry.npmjs.org",
    "binaries.prisma.sh",
    "db.abcdefghijklmnopqrst.supabase.co",
  ]);
  assert.equal(sandbox.terminated, 1);
  assert.ok(!JSON.stringify(result).includes("super-secret"));
  assert.ok(!JSON.stringify(result).includes("postgresql://"));
});

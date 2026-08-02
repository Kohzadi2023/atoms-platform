import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  E2BDatabaseMigrationRunner,
  SupabaseDatabaseProvider,
  VaultSecretStore,
  runPhase3ProviderStagingScenario,
} from "@atoms/database-provider";
import { createPrismaClient } from "@atoms/db";
import { E2BSandboxAdapter } from "@atoms/sandbox-provider";
import { z } from "zod";

import type { DatabaseRecoveryQueue } from "./database-reconciliation-domain.js";
import { PrismaDatabaseReconciliationRepository } from "./database-reconciliation-repository.js";
import { DatabaseReconciler } from "./database-reconciler.js";

const explicitlyEnabled = process.env.RUN_LIVE_PHASE3_STAGING === "true";
const destructiveConfirmation =
  "PROVISION_MIGRATE_AND_DESTROY_SUPABASE_STAGING_DATABASE" as const;
const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);
const optionalPositiveInteger = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().min(1).max(100).default(1),
);

const EnvironmentSchema = z
  .object({
    RUN_LIVE_PHASE3_STAGING: z.literal("true"),
    PHASE3_STAGING_DESTRUCTIVE_CONFIRMATION: z.literal(
      destructiveConfirmation,
    ),
    PHASE3_INTEGRATION_DATABASE_CONFIRMATION: z.literal(
      "DEDICATED_EPHEMERAL_DATABASE",
    ),
    PHASE3_STAGING_CHANGE_TICKET: z
      .string()
      .trim()
      .min(1)
      .max(191)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
    PHASE3_STAGING_MEASURED_COST_CAD: z
      .string()
      .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/),
    PHASE3_STAGING_EVIDENCE_PATH: z.string().trim().min(1).max(1_024),
    DATABASE_URL: z.string().url(),
    SUPABASE_ACCESS_TOKEN: z.string().min(1),
    SUPABASE_ORGANIZATION_SLUG: z.string().trim().min(1).max(191),
    SUPABASE_MANAGEMENT_API_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().default("https://api.supabase.com"),
    ),
    VAULT_ADDR: z.string().url(),
    VAULT_TOKEN: z.string().min(1),
    VAULT_KV_MOUNT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().min(1).default("secret"),
    ),
    VAULT_NAMESPACE: optionalNonEmptyString,
    E2B_API_KEY: z.string().min(1),
    E2B_TEMPLATE: optionalNonEmptyString,
    E2B_ALLOWED_HOSTS: z
      .string()
      .default("registry.npmjs.org,binaries.prisma.sh"),
    PHASE3_STAGING_DATABASE_REGION: z
      .enum(["americas", "emea", "apac"])
      .default("americas"),
    PHASE3_STAGING_MIN_OTHER_ORG_CONTROLS: optionalPositiveInteger,
    PHASE3_STAGING_MIN_CUSTOMER_CONTROLS: optionalPositiveInteger,
  })
  .passthrough();

test(
  "live Phase 3 provider exit migrates in E2B and deletes only through approved orphan reconciliation",
  {
    skip: explicitlyEnabled
      ? false
      : "requires protected PostgreSQL, Supabase, Vault, and E2B staging with exact billable/destructive confirmation",
    timeout: 20 * 60_000,
  },
  async () => {
    const environment = EnvironmentSchema.parse(process.env);
    const prisma = createPrismaClient(environment.DATABASE_URL);
    const repository = new PrismaDatabaseReconciliationRepository(prisma);
    const recoveryQueue = new RejectingRecoveryQueue();
    const secretStore = new VaultSecretStore({
      address: environment.VAULT_ADDR,
      token: environment.VAULT_TOKEN,
      mount: environment.VAULT_KV_MOUNT,
      ...(environment.VAULT_NAMESPACE === undefined
        ? {}
        : { namespace: environment.VAULT_NAMESPACE }),
    });
    const provider = new SupabaseDatabaseProvider({
      accessToken: environment.SUPABASE_ACCESS_TOKEN,
      organizationSlug: environment.SUPABASE_ORGANIZATION_SLUG,
      baseUrl: environment.SUPABASE_MANAGEMENT_API_URL,
      secretStore,
    });
    const sandbox = new E2BSandboxAdapter({ apiKey: environment.E2B_API_KEY });
    const migrationRunner = new E2BDatabaseMigrationRunner({
      provider: sandbox,
      ...(environment.E2B_TEMPLATE === undefined
        ? {}
        : { template: environment.E2B_TEMPLATE }),
      packageHosts: environment.E2B_ALLOWED_HOSTS.split(",")
        .map((host) => host.trim())
        .filter((host) => host.length > 0),
    });
    const fixtureRoot = fileURLToPath(
      new URL("../../../examples/generated-app-database/", import.meta.url),
    );
    const startedAt = new Date();

    try {
      const inventoryAudit = await provider.auditManagedInventoryScope();
      assert.ok(
        inventoryAudit.excludedOtherOrganizationProjects >=
          environment.PHASE3_STAGING_MIN_OTHER_ORG_CONTROLS,
        "staging inventory needs the configured cross-organization control projects",
      );
      assert.ok(
        inventoryAudit.excludedUnmanagedInConfiguredOrganization >=
          environment.PHASE3_STAGING_MIN_CUSTOMER_CONTROLS,
        "staging inventory needs the configured customer-created control projects",
      );
      assert.equal(
        inventoryAudit.missingOrganizationAttribution,
        0,
        "every visible provider project must carry organization attribution",
      );
      const evidence = await runPhase3ProviderStagingScenario({
        provider,
        secretStore,
        migrationRunner,
        fixtureFiles: await readFixtureFiles(fixtureRoot),
        changeTicket: environment.PHASE3_STAGING_CHANGE_TICKET,
        measuredVariableCostCadMicros: parseCadMicros(
          environment.PHASE3_STAGING_MEASURED_COST_CAD,
        ),
        region: environment.PHASE3_STAGING_DATABASE_REGION,
        inventoryEvidence: {
          visibleProjects: inventoryAudit.visibleProjects,
          configuredOrganizationProjects:
            inventoryAudit.configuredOrganizationProjects,
          managedResources: inventoryAudit.managedResources,
          excludedOtherOrganizationProjects:
            inventoryAudit.excludedOtherOrganizationProjects,
          excludedUnmanagedInConfiguredOrganization:
            inventoryAudit.excludedUnmanagedInConfiguredOrganization,
          missingOrganizationAttribution:
            inventoryAudit.missingOrganizationAttribution,
        },
        cleanupOwnedResource: async ({
          externalId,
          connectionSecretRef,
        }) => {
          let reconciliationNow = new Date();
          const reportOnlyReconciler = new DatabaseReconciler({
            repository,
            provider,
            recoveryQueue,
            staleAfterMs: 60_000,
            orphanGraceMs: 1_000,
            abandonedSweepAfterMs: 60_000,
            cleanupApprovedOrphans: false,
            now: () => reconciliationNow,
          });
          const first = await reportOnlyReconciler.reconcile();
          assert.equal(first.outcome, "completed");
          assert.ok(first.summary.orphanCandidates >= 1);

          reconciliationNow = new Date(reconciliationNow.getTime() + 1_100);
          const second = await reportOnlyReconciler.reconcile();
          assert.equal(second.outcome, "completed");
          assert.ok(second.summary.orphanCandidates >= 1);

          const finding =
            await prisma.databaseReconciliationFinding.findFirstOrThrow({
              where: {
                provider: "SUPABASE",
                kind: "ORPHAN_PROVIDER_RESOURCE",
                externalId,
              },
            });
          assert.equal(finding.status, "OPEN");
          assert.ok(finding.observationCount >= 2);
          const approval = await repository.approveOrphanCleanup(
            {
              findingId: finding.id,
              externalId,
              approvedBy: `staging:${environment.PHASE3_STAGING_CHANGE_TICKET}`,
              confirmation: "APPROVE_ORPHAN_DATABASE_DELETION",
            },
            reconciliationNow,
          );
          assert.equal(approval.kind, "approved");

          reconciliationNow = new Date(reconciliationNow.getTime() + 100);
          const cleanupReconciler = new DatabaseReconciler({
            repository,
            provider,
            recoveryQueue,
            staleAfterMs: 60_000,
            orphanGraceMs: 1_000,
            abandonedSweepAfterMs: 60_000,
            cleanupApprovedOrphans: true,
            now: () => reconciliationNow,
          });
          const cleaned = await cleanupReconciler.reconcile();
          assert.equal(cleaned.outcome, "completed");
          assert.equal(cleaned.summary.cleanedResources, 1);
          const resolved =
            await prisma.databaseReconciliationFinding.findUniqueOrThrow({
              where: { id: finding.id },
            });
          assert.equal(resolved.status, "RESOLVED");
          assert.equal(resolved.resolution, "DELETED_AFTER_APPROVAL");
          await secretStore.revoke(connectionSecretRef);
          return {
            strategy: "approval_gated_orphan_reconciliation",
            observationCount: resolved.observationCount,
            cleanedResources: cleaned.summary.cleanedResources,
            findingStatus: resolved.status,
          };
        },
      });

      const evidencePath = resolve(environment.PHASE3_STAGING_EVIDENCE_PATH);
      await mkdir(dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      assert.equal(
        evidence.result,
        "PASSED",
        `Phase 3 staging failed: ${evidence.errors.map((error) => error.code).join(", ")}`,
      );
      assert.ok(
        JSON.stringify(
          evidence.gates.find((gate) => gate.name === "provider_cleanup")
            ?.details,
        ).includes("approval_gated_orphan_reconciliation"),
      );
    } finally {
      const sweeps = await prisma.databaseReconciliationSweep.findMany({
        where: { startedAt: { gte: startedAt } },
        select: { id: true },
      });
      const sweepIds = sweeps.map((sweep) => sweep.id);
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

class RejectingRecoveryQueue implements DatabaseRecoveryQueue {
  enqueue(): Promise<void> {
    throw new Error("The dedicated provider-exit database contained stale operations");
  }

  async close(): Promise<void> {}
}

async function readFixtureFiles(
  root: string,
): Promise<ReadonlyArray<{ readonly path: string; readonly content: string }>> {
  const paths: string[] = [];
  await walk(root, paths);
  return Promise.all(
    paths
      .filter((path) => !path.split(sep).includes("node_modules"))
      .sort()
      .map(async (path) => ({
        path: relative(root, path).split(sep).join("/"),
        content: await readFile(path, "utf8"),
      })),
  );
}

async function walk(directory: string, output: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else if (entry.isFile()) output.push(path);
  }
}

function parseCadMicros(value: string): number {
  const [whole = "0", fractional = ""] = value.split(".");
  const micros =
    BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, "0"));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Measured staging cost is outside the supported range");
  }
  return Number(micros);
}

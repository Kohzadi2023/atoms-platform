import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPrismaClient } from "@atoms/db";

import { PostgresRunProviderBudgetStore } from "./model-budget.js";

const ENABLED = process.env.RUN_PROVIDER_BUDGET_INTEGRATION_TESTS === "true";
const CONFIRMATION = "DEDICATED_EPHEMERAL_DATABASE";

test(
  "PostgreSQL provider budget survives restart, serializes concurrency, and cannot be enlarged",
  { skip: !ENABLED },
  async () => {
    assert.equal(
      process.env.PROVIDER_BUDGET_INTEGRATION_CONFIRMATION,
      CONFIRMATION,
      `PROVIDER_BUDGET_INTEGRATION_CONFIRMATION must equal ${CONFIRMATION}`,
    );
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl, "DATABASE_URL is required");

    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const runId = randomUUID();
    const suffix = randomUUID().slice(0, 12);

    const firstClient = createPrismaClient(databaseUrl);
    try {
      await firstClient.workspace.create({
        data: {
          id: workspaceId,
          name: `Provider budget integration ${suffix}`,
          slug: `provider-budget-${suffix}`,
        },
      });
      await firstClient.project.create({
        data: {
          id: projectId,
          workspaceId,
          name: `Provider budget project ${suffix}`,
          slug: `provider-budget-project-${suffix}`,
        },
      });
      await firstClient.agentRun.create({
        data: {
          id: runId,
          workspaceId,
          projectId,
          prompt: "Provider budget integration probe",
        },
      });

      const store = new PostgresRunProviderBudgetStore(firstClient);
      const concurrent = await Promise.all([
        store.reserve({
          runId,
          reservationUsdMicros: 600_000,
          totalBudgetUsdMicros: 1_000_000,
        }),
        store.reserve({
          runId,
          reservationUsdMicros: 600_000,
          totalBudgetUsdMicros: 1_000_000,
        }),
      ]);

      assert.equal(concurrent.filter((result) => result.accepted).length, 1);
      assert.equal(concurrent.filter((result) => !result.accepted).length, 1);
      assert.ok(
        concurrent.every((result) => result.remainingUsdMicros === 400_000),
      );
    } finally {
      await firstClient.$disconnect();
    }

    const secondClient = createPrismaClient(databaseUrl);
    try {
      const restartedStore = new PostgresRunProviderBudgetStore(secondClient);

      const afterRestart = await restartedStore.reserve({
        runId,
        reservationUsdMicros: 100_000,
        totalBudgetUsdMicros: 2_000_000,
      });
      assert.deepEqual(afterRestart, {
        accepted: true,
        remainingUsdMicros: 300_000,
      });

      const cannotEnlarge = await restartedStore.reserve({
        runId,
        reservationUsdMicros: 400_000,
        totalBudgetUsdMicros: 2_000_000,
      });
      assert.deepEqual(cannotEnlarge, {
        accepted: false,
        remainingUsdMicros: 300_000,
      });

      const rows = await secondClient.$queryRaw<
        Array<{ totalUsdMicros: number; reservedUsdMicros: number }>
      >`
        SELECT
          total_usd_micros AS "totalUsdMicros",
          reserved_usd_micros AS "reservedUsdMicros"
        FROM atoms_runtime.run_provider_budgets
        WHERE run_id = ${runId}::uuid
      `;
      assert.deepEqual(rows, [
        { totalUsdMicros: 1_000_000, reservedUsdMicros: 700_000 },
      ]);

      const tightened = await restartedStore.reserve({
        runId,
        reservationUsdMicros: 150_000,
        totalBudgetUsdMicros: 800_000,
      });
      assert.deepEqual(tightened, {
        accepted: false,
        remainingUsdMicros: 100_000,
      });
    } finally {
      await secondClient.workspace.delete({ where: { id: workspaceId } });
      await secondClient.$disconnect();
    }
  },
);

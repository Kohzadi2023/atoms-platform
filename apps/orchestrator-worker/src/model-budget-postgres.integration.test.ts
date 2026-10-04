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
        exhausted: "run",
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
        exhausted: "run",
        remainingUsdMicros: 100_000,
      });
    } finally {
      await secondClient.workspace.delete({ where: { id: workspaceId } });
      await secondClient.$disconnect();
    }
  },
);

test(
  "PostgreSQL workspace daily ceiling serializes runs of one workspace and records actual usage",
  { skip: !ENABLED },
  async () => {
    assert.equal(
      process.env.PROVIDER_BUDGET_INTEGRATION_CONFIRMATION,
      CONFIRMATION,
      `PROVIDER_BUDGET_INTEGRATION_CONFIRMATION must equal ${CONFIRMATION}`,
    );
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl, "DATABASE_URL is required");

    const suffix = randomUUID().slice(0, 12);
    const workspaceIds = [randomUUID(), randomUUID()] as const;
    const runA = randomUUID();
    const runB = randomUUID();
    const runOther = randomUUID();

    const client = createPrismaClient(databaseUrl);
    try {
      for (const [index, workspaceId] of workspaceIds.entries()) {
        await client.workspace.create({
          data: {
            id: workspaceId,
            name: `Workspace budget integration ${suffix}-${String(index)}`,
            slug: `workspace-budget-${suffix}-${String(index)}`,
          },
        });
      }
      const projectIds = [randomUUID(), randomUUID()] as const;
      for (const [index, projectId] of projectIds.entries()) {
        await client.project.create({
          data: {
            id: projectId,
            workspaceId: workspaceIds[index] as string,
            name: `Workspace budget project ${suffix}-${String(index)}`,
            slug: `workspace-budget-project-${suffix}-${String(index)}`,
          },
        });
      }
      for (const [id, index] of [
        [runA, 0],
        [runB, 0],
        [runOther, 1],
      ] as const) {
        await client.agentRun.create({
          data: {
            id,
            workspaceId: workspaceIds[index] as string,
            projectId: projectIds[index] as string,
            prompt: "Workspace budget integration probe",
          },
        });
      }

      const store = new PostgresRunProviderBudgetStore(client);
      const reserve = (runId: string, reservationUsdMicros: number) =>
        store.reserve({
          runId,
          reservationUsdMicros,
          totalBudgetUsdMicros: 1_000_000,
          workspaceDailyBudgetUsdMicros: 1_000_000,
        });

      // Two different runs of one workspace race for the same daily ceiling.
      const raced = await Promise.all([reserve(runA, 600_000), reserve(runB, 600_000)]);
      assert.equal(raced.filter((result) => result.accepted).length, 1);
      const rejected = raced.find((result) => !result.accepted);
      assert.equal(rejected?.exhausted, "workspace");
      assert.equal(rejected?.remainingUsdMicros, 400_000);

      // Another run of the same workspace still fits inside what is left.
      const acceptedRun = raced[0]?.accepted ? runA : runB;
      const otherRunOfWorkspace = acceptedRun === runA ? runB : runA;
      const fitted = await reserve(otherRunOfWorkspace, 300_000);
      assert.equal(fitted.accepted, true);
      assert.equal(fitted.remainingUsdMicros, 700_000);
      // The reservation reports the UTC day of the window it was charged to.
      assert.match(fitted.windowDate ?? "", /^d{4}-d{2}-d{2}$/u);
      const overflow = await reserve(acceptedRun, 200_000);
      assert.equal(overflow.accepted, false);
      assert.equal(overflow.exhausted, "workspace");

      // A different workspace has its own window and is unaffected.
      const otherWorkspace = await reserve(runOther, 900_000);
      assert.equal(otherWorkspace.accepted, true);
      assert.equal(otherWorkspace.remainingUsdMicros, 100_000);
      assert.equal(otherWorkspace.windowDate, fitted.windowDate);

      const windows = await client.$queryRaw<
        Array<{ workspaceId: string; reservedUsdMicros: number }>
      >`
        SELECT
          workspace_id::text AS "workspaceId",
          reserved_usd_micros AS "reservedUsdMicros"
        FROM atoms_runtime.workspace_provider_budget_windows
        WHERE workspace_id IN (${workspaceIds[0]}::uuid, ${workspaceIds[1]}::uuid)
        ORDER BY reserved_usd_micros
      `;
      assert.deepEqual(
        windows.map((row) => row.reservedUsdMicros),
        [900_000, 900_000],
      );

      // A run-level rejection reports the run scope and does not touch the window.
      const runLevel = await reserve(runOther, 200_000);
      assert.equal(runLevel.exhausted, "run");

      // Actual usage accumulates without changing what is reserved.
      await store.recordActual({ runId: runOther, actualUsdMicros: 1_234 });
      await store.recordActual({ runId: runOther, actualUsdMicros: 1_234 });
      const ledger = await client.$queryRaw<
        Array<{ reservedUsdMicros: number; actualUsdMicros: number }>
      >`
        SELECT
          reserved_usd_micros AS "reservedUsdMicros",
          actual_usd_micros AS "actualUsdMicros"
        FROM atoms_runtime.run_provider_budgets
        WHERE run_id = ${runOther}::uuid
      `;
      assert.deepEqual(ledger, [{ reservedUsdMicros: 900_000, actualUsdMicros: 2_468 }]);

      // Settling gives the unused part of a reservation back to both the run's
      // ledger and the workspace window it was charged to, and never below zero.
      const reservedNow = async () => {
        const [runRow] = await client.$queryRaw<Array<{ reservedUsdMicros: number }>>`
          SELECT reserved_usd_micros AS "reservedUsdMicros"
          FROM atoms_runtime.run_provider_budgets
          WHERE run_id = ${runOther}::uuid
        `;
        const [windowRow] = await client.$queryRaw<Array<{ reservedUsdMicros: number }>>`
          SELECT reserved_usd_micros AS "reservedUsdMicros"
          FROM atoms_runtime.workspace_provider_budget_windows
          WHERE workspace_id = ${workspaceIds[1]}::uuid
            AND window_date = ${otherWorkspace.windowDate as string}::date
        `;
        return [runRow?.reservedUsdMicros, windowRow?.reservedUsdMicros];
      };
      await store.release({
        runId: runOther,
        releaseUsdMicros: 400_000,
        ...(otherWorkspace.windowDate === undefined
          ? {}
          : { windowDate: otherWorkspace.windowDate }),
      });
      assert.deepEqual(await reservedNow(), [500_000, 500_000]);
      await store.release({
        runId: runOther,
        releaseUsdMicros: 10_000_000,
        ...(otherWorkspace.windowDate === undefined
          ? {}
          : { windowDate: otherWorkspace.windowDate }),
      });
      assert.deepEqual(await reservedNow(), [0, 0]);
    } finally {
      for (const workspaceId of workspaceIds) {
        await client.workspace.delete({ where: { id: workspaceId } });
      }
      await client.$disconnect();
    }
  },
);

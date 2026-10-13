import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPrismaClient } from "@atoms/db";

import { EmbeddingBudget } from "./index.js";

const ENABLED = process.env.RUN_MEMORY_INTEGRATION_TESTS === "true";
const CONFIRMATION = "DEDICATED_EPHEMERAL_DATABASE";

test(
  "embedding budget: atomic daily cap under concurrency, settlement, day rollover, isolation",
  { skip: !ENABLED },
  async () => {
    assert.equal(process.env.MEMORY_INTEGRATION_CONFIRMATION, CONFIRMATION);
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl, "DATABASE_URL is required");

    const prisma = createPrismaClient(databaseUrl);
    const suffix = randomUUID().slice(0, 12);
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    try {
      for (const [id, label] of [
        [workspaceA, "a"],
        [workspaceB, "b"],
      ] as const) {
        await prisma.workspace.create({
          data: { id, name: `Embedding budget ${label} ${suffix}`, slug: `embedding-budget-${label}-${suffix}` },
        });
      }
      let now = new Date("2026-10-13T10:00:00Z");
      const budget = new EmbeddingBudget(prisma, () => now);

      // Ten simultaneous reservations of 300 against a cap of 1000: exactly three fit.
      const results = await Promise.all(
        Array.from({ length: 10 }, () => budget.reserve(workspaceA, 300, 1_000)),
      );
      assert.equal(results.filter(Boolean).length, 3);
      assert.equal(await budget.usedToday(workspaceA), 900);

      // A reservation larger than the cap is refused even on an empty day, and writes nothing.
      assert.equal(await budget.reserve(workspaceB, 1_001, 1_000), false);
      assert.equal(await budget.usedToday(workspaceB), 0);

      // Settling down frees room; settling up is recorded; it never goes below zero.
      await budget.adjust(workspaceA, -400);
      assert.equal(await budget.usedToday(workspaceA), 500);
      assert.equal(await budget.reserve(workspaceA, 500, 1_000), true);
      assert.equal(await budget.reserve(workspaceA, 1, 1_000), false);
      await budget.adjust(workspaceA, -5_000);
      assert.equal(await budget.usedToday(workspaceA), 0);

      // One workspace's spending never counts against another's.
      assert.equal(await budget.reserve(workspaceA, 1_000, 1_000), true);
      assert.equal(await budget.reserve(workspaceB, 1_000, 1_000), true);

      // The next UTC day starts empty.
      now = new Date("2026-10-14T00:00:01Z");
      assert.equal(await budget.usedToday(workspaceA), 0);
      assert.equal(await budget.reserve(workspaceA, 1_000, 1_000), true);
    } finally {
      await prisma.workspace.deleteMany({ where: { id: { in: [workspaceA, workspaceB] } } });
      await prisma.$disconnect();
    }
  },
);

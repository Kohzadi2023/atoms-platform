import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { WorkerReadinessReportSchema } from "@atoms/contracts";

import {
  WorkerReadinessPublisher,
  buildWorkerReadinessReport,
  type ReadinessStore,
  type WorkerReadinessFacts,
} from "./readiness-publisher.js";

const NOW = new Date("2026-09-19T12:00:00.000Z");

const READY_FACTS: WorkerReadinessFacts = {
  runBudgetUsdMicros: 2_000_000,
  workspaceDailyBudgetUsdMicros: 20_000_000,
  providerCredentialsPresent: true,
  egressVerifiedAt: "2026-09-18T10:00:00.000Z",
  attachmentContractVerified: true,
  browserViabilityRequired: true,
};

test("a fully configured worker reports every fact true", () => {
  const report = buildWorkerReadinessReport(READY_FACTS, NOW);

  assert.deepEqual(report, {
    version: 1,
    publishedAt: NOW.toISOString(),
    runBudgetConfigured: true,
    workspaceCeilingConfigured: true,
    providerCredentialsPresent: true,
    egressVerified: true,
    attachmentContractVerified: true,
    browserViabilityRequired: true,
  });
});

test("a zero budget or ceiling reads as not configured", () => {
  const report = buildWorkerReadinessReport(
    { ...READY_FACTS, runBudgetUsdMicros: 0, workspaceDailyBudgetUsdMicros: 0 },
    NOW,
  );

  assert.equal(report.runBudgetConfigured, false);
  assert.equal(report.workspaceCeilingConfigured, false);
});

test("egress counts as verified only with a real, non-future probe date", () => {
  for (const egressVerifiedAt of [undefined, "", "yesterday", "2026-09-20T00:00:00.000Z"]) {
    assert.equal(
      buildWorkerReadinessReport({ ...READY_FACTS, egressVerifiedAt }, NOW).egressVerified,
      false,
      String(egressVerifiedAt),
    );
  }
});

test("the published payload is the schema-valid report and carries no configuration value", async () => {
  const writes: Array<{ key: string; value: string; ttl: number }> = [];
  const store: ReadinessStore = {
    set: async (key, value, ttl) => {
      writes.push({ key, value, ttl });
    },
  };
  await new WorkerReadinessPublisher({
    store,
    key: "atoms:readiness:worker",
    facts: READY_FACTS,
    now: () => NOW,
  }).publishOnce();

  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.key, "atoms:readiness:worker");
  assert.ok((writes[0]?.ttl ?? 0) > 90);
  const parsed = WorkerReadinessReportSchema.parse(JSON.parse(writes[0]?.value ?? ""));
  assert.equal(parsed.runBudgetConfigured, true);
  // Booleans only: the budget amount itself is never published.
  assert.equal((writes[0]?.value ?? "").includes("2000000"), false);
});

test("a failed write is reported and does not throw", async () => {
  const errors: unknown[] = [];
  const publisher = new WorkerReadinessPublisher({
    store: {
      set: async () => {
        throw new Error("redis down");
      },
    },
    key: "k",
    facts: READY_FACTS,
    now: () => NOW,
    onError: (error) => errors.push(error),
  });

  await publisher.publishOnce();

  assert.equal(errors.length, 1);
});

test("start publishes immediately and stop ends the heartbeat", async () => {
  let writes = 0;
  const publisher = new WorkerReadinessPublisher({
    store: {
      set: async () => {
        writes += 1;
      },
    },
    key: "k",
    facts: READY_FACTS,
    intervalMs: 5,
  });

  publisher.start();
  publisher.start();
  await new Promise((done) => setTimeout(done, 40));
  publisher.stop();
  const atStop = writes;
  await new Promise((done) => setTimeout(done, 30));

  assert.ok(atStop >= 2, "immediate publish plus at least one heartbeat");
  assert.equal(writes, atStop);
});

test("the worker publishes readiness from its real configuration and stops it on shutdown", async () => {
  const source = await readFile(resolve(process.cwd(), "src/main.ts"), "utf8");

  assert.match(source, /new WorkerReadinessPublisher\(/u);
  assert.match(source, /workerReadinessKey\(environment\.RUN_QUEUE_PREFIX\)/u);
  assert.match(source, /referenceContractIntact\(\)/u);
  assert.match(source, /SANDBOX_EGRESS_VERIFIED_AT/u);
  assert.match(source, /browserViabilityRequired: environment\.PREVIEW_BROWSER_VIABILITY === "required"/u);
  assert.match(source, /readinessPublisher\.stop\(\)/u);
  assert.match(source, /readinessPublisher\.start\(\)/u);
});

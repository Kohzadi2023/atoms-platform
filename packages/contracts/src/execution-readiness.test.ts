import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKER_READINESS_MAX_AGE_MS,
  WorkerReadinessReportSchema,
  evaluateExecutionReadiness,
  workerReadinessKey,
  type WorkerReadinessReport,
} from "./execution-readiness.js";

const NOW = new Date("2026-09-19T12:00:00.000Z");

function report(overrides: Partial<WorkerReadinessReport> = {}): WorkerReadinessReport {
  return {
    version: 1,
    publishedAt: NOW.toISOString(),
    runBudgetConfigured: true,
    workspaceCeilingConfigured: true,
    providerCredentialsPresent: true,
    egressVerified: true,
    attachmentContractVerified: true,
    ...overrides,
  };
}

test("ready only when the flag is on and every worker precondition holds", () => {
  const result = evaluateExecutionReadiness({
    controlPlaneEnabled: true,
    worker: report(),
    now: NOW,
  });

  assert.equal(result.executionReady, true);
  assert.equal(result.preconditionsMet, true);
  assert.equal(result.inconsistent, false);
  assert.deepEqual(result.failingGates, []);
  assert.equal(result.platformReady, true);
});

test("the flag off is consistent and not ready, even when the worker is fully ready", () => {
  const result = evaluateExecutionReadiness({
    controlPlaneEnabled: false,
    worker: report(),
    now: NOW,
  });

  assert.equal(result.executionReady, false);
  assert.equal(result.preconditionsMet, true);
  assert.equal(result.inconsistent, false);
});

test("the flag on while the worker budget is zero is inconsistent", () => {
  const result = evaluateExecutionReadiness({
    controlPlaneEnabled: true,
    worker: report({ runBudgetConfigured: false }),
    now: NOW,
  });

  assert.equal(result.executionReady, false);
  assert.equal(result.inconsistent, true);
  assert.deepEqual(result.failingGates, ["G1"]);
});

test("each gate fails on its own and is named", () => {
  const cases: Array<[Partial<WorkerReadinessReport>, string]> = [
    [{ workspaceCeilingConfigured: false }, "G1"],
    [{ attachmentContractVerified: false }, "G4"],
    [{ egressVerified: false }, "G5"],
    [{ providerCredentialsPresent: false }, "LOCK_3"],
  ];
  for (const [override, gate] of cases) {
    const result = evaluateExecutionReadiness({
      controlPlaneEnabled: false,
      worker: report(override),
      now: NOW,
    });
    assert.deepEqual(result.failingGates, [gate]);
    assert.equal(result.preconditionsMet, false);
  }
});

test("a worker that never reported fails every gate", () => {
  const result = evaluateExecutionReadiness({
    controlPlaneEnabled: true,
    worker: null,
    now: NOW,
  });

  assert.equal(result.workerState, "missing");
  assert.deepEqual(result.failingGates, ["G1", "G4", "G5", "LOCK_3"]);
  assert.equal(result.inconsistent, true);
});

test("a stale or future-dated report is not trusted", () => {
  const at = (offsetMs: number): WorkerReadinessReport =>
    report({ publishedAt: new Date(NOW.getTime() + offsetMs).toISOString() });

  const stale = evaluateExecutionReadiness({
    controlPlaneEnabled: true,
    worker: at(-WORKER_READINESS_MAX_AGE_MS - 1),
    now: NOW,
  });
  assert.equal(stale.workerState, "stale");
  assert.equal(stale.executionReady, false);

  const future = evaluateExecutionReadiness({
    controlPlaneEnabled: true,
    worker: at(WORKER_READINESS_MAX_AGE_MS + 1),
    now: NOW,
  });
  assert.equal(future.workerState, "stale");

  const edge = evaluateExecutionReadiness({
    controlPlaneEnabled: true,
    worker: at(-WORKER_READINESS_MAX_AGE_MS),
    now: NOW,
  });
  assert.equal(edge.workerState, "reporting");
});

test("the published report carries booleans only and rejects extra fields", () => {
  assert.equal(WorkerReadinessReportSchema.safeParse(report()).success, true);
  assert.equal(
    WorkerReadinessReportSchema.safeParse({ ...report(), openaiKey: "sk-secret" }).success,
    false,
  );
  assert.equal(
    WorkerReadinessReportSchema.safeParse({ ...report(), egressVerified: "yes" }).success,
    false,
  );
});

test("the redis key follows the queue prefix", () => {
  assert.equal(workerReadinessKey(), "atoms:readiness:worker");
  assert.equal(workerReadinessKey("staging"), "staging:readiness:worker");
});

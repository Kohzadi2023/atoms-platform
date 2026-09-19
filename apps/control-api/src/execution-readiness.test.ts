import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerReadinessReport } from "@atoms/contracts";

import { buildControlApi } from "./app.js";
import {
  ExecutionReadinessService,
  type WorkerReadinessSource,
} from "./execution-readiness.js";
import type { ControlRepository } from "./repository.js";
import type { RunQueue } from "./run-queue.js";

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
    browserViabilityRequired: true,
    ...overrides,
  };
}

class FakeSource implements WorkerReadinessSource {
  reads = 0;
  constructor(private value: WorkerReadinessReport | null | Error) {}
  set(value: WorkerReadinessReport | null | Error): void {
    this.value = value;
  }
  async read(): Promise<WorkerReadinessReport | null> {
    this.reads += 1;
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }
}

test("service reports ready when the flag is on and the worker meets every precondition", async () => {
  const service = new ExecutionReadinessService({
    source: new FakeSource(report()),
    controlPlaneEnabled: true,
    now: () => NOW,
  });

  const result = await service.current();

  assert.equal(result.executionReady, true);
  assert.equal(result.inconsistent, false);
});

test("service reports the locks as inconsistent when the flag is on and the worker budget is zero", async () => {
  const service = new ExecutionReadinessService({
    source: new FakeSource(report({ runBudgetConfigured: false })),
    controlPlaneEnabled: true,
    now: () => NOW,
  });

  const result = await service.current();

  assert.equal(result.inconsistent, true);
  assert.deepEqual(result.failingGates, ["G1"]);
});

test("a source that fails or has nothing reads as not ready, never ready", async () => {
  for (const value of [null, new Error("redis down")]) {
    const service = new ExecutionReadinessService({
      source: new FakeSource(value),
      controlPlaneEnabled: true,
      now: () => NOW,
      cacheMs: 0,
    });
    const result = await service.current();
    assert.equal(result.executionReady, false);
    assert.equal(result.workerState, "missing");
    assert.equal(result.inconsistent, true);
  }
});

test("results are cached briefly so probes do not become a Redis read each", async () => {
  let clock = NOW.getTime();
  const source = new FakeSource(report());
  const service = new ExecutionReadinessService({
    source,
    controlPlaneEnabled: true,
    now: () => new Date(clock),
    cacheMs: 5_000,
  });

  await service.current();
  clock += 1_000;
  await service.current();
  assert.equal(source.reads, 1);

  clock += 5_000;
  await service.current();
  assert.equal(source.reads, 2);
});

const repository = {} as unknown as ControlRepository;
const queue: RunQueue = { enqueue: async () => undefined, close: async () => undefined };

test("/readyz stays 200 with status ready and adds platformReady and the execution state", async () => {
  const app = await buildControlApi({
    repository,
    runQueue: queue,
    authRequired: false,
    runExecutionEnabled: true,
    now: () => NOW,
    executionReadiness: new ExecutionReadinessService({
      source: new FakeSource(report({ egressVerified: false })),
      controlPlaneEnabled: true,
      now: () => NOW,
    }),
  });

  const response = await app.inject({ method: "GET", url: "/readyz" });
  const body = response.json() as Record<string, unknown>;

  assert.equal(response.statusCode, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.platformReady, true);
  assert.equal(body.executionReady, false);
  assert.deepEqual((body.execution as { failingGates: string[] }).failingGates, ["G5"]);
  assert.equal((body.execution as { inconsistent: boolean }).inconsistent, true);
  await app.close();
});

test("/readyz without a worker report is still 200 and says execution is not ready", async () => {
  const app = await buildControlApi({
    repository,
    runQueue: queue,
    authRequired: false,
    runExecutionEnabled: false,
    now: () => NOW,
  });

  const response = await app.inject({ method: "GET", url: "/readyz" });
  const body = response.json() as {
    status: string;
    platformReady: boolean;
    executionReady: boolean;
    execution: { workerState: string; controlPlaneEnabled: boolean; inconsistent: boolean };
  };

  assert.equal(response.statusCode, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.platformReady, true);
  assert.equal(body.executionReady, false);
  assert.equal(body.execution.workerState, "missing");
  assert.equal(body.execution.controlPlaneEnabled, false);
  // Flag off is a deliberate state, not a disagreement between the locks.
  assert.equal(body.execution.inconsistent, false);
  await app.close();
});

test("/readyz stays unauthenticated and exposes no configured value", async () => {
  const app = await buildControlApi({
    repository,
    runQueue: queue,
    authRequired: true,
    authenticator: {
      authenticate: async () => {
        throw new Error("must not be called for /readyz");
      },
    },
    runExecutionEnabled: true,
    now: () => NOW,
    executionReadiness: new ExecutionReadinessService({
      source: new FakeSource(report()),
      controlPlaneEnabled: true,
      now: () => NOW,
    }),
  });

  const response = await app.inject({ method: "GET", url: "/readyz" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json()).sort(), [
    "execution",
    "executionReady",
    "platformReady",
    "status",
  ]);
  await app.close();
});

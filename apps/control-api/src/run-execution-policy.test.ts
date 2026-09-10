import assert from "node:assert/strict";
import test from "node:test";

import { buildControlApi } from "./app.js";
import type { RunRecord } from "./domain.js";
import type { ControlRepository } from "./repository.js";
import type { RunQueue } from "./run-queue.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-09-10T04:30:00.000Z");

function createRun(status: RunRecord["status"], controlVersion = 1): RunRecord {
  return {
    id: RUN_ID,
    workspaceId: "00000000-0000-4000-8000-000000000001",
    projectId: PROJECT_ID,
    status,
    prompt: "Safety gate test",
    eventSequence: 0,
    controlVersion,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: status === "RUNNING" ? NOW : null,
    pausedAt: status === "PAUSED" ? NOW : null,
    completedAt: null,
    cancelledAt: null,
  };
}

function queueTracker() {
  let enqueued = false;
  const queue: RunQueue = {
    async enqueue() {
      enqueued = true;
    },
    async close() {},
  };
  return { queue, wasEnqueued: () => enqueued };
}

test("disabled policy rejects run creation before repository or queue mutation", async () => {
  let repositoryTouched = false;
  const repository = new Proxy({} as ControlRepository, {
    get(_target, property) {
      if (property === "close") return async () => undefined;
      return async () => {
        repositoryTouched = true;
        throw new Error(`Unexpected repository call: ${String(property)}`);
      };
    },
  });
  const tracker = queueTracker();
  const app = await buildControlApi({
    repository,
    runQueue: tracker.queue,
    authRequired: false,
    runExecutionEnabled: false,
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/runs`,
      headers: { "idempotency-key": "kill-switch-create-1" },
      payload: { prompt: "Do not execute providers", attachmentIds: [] },
    });

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      error: {
        code: "RUN_EXECUTION_DISABLED",
        message: "Run execution is disabled by deployment policy",
      },
    });
    assert.equal(repositoryTouched, false);
    assert.equal(tracker.wasEnqueued(), false);
  } finally {
    await app.close();
  }
});

test("disabled policy rejects resume before state transition or queue enqueue", async () => {
  let transitioned = false;
  const pausedRun = createRun("PAUSED");
  const repository = new Proxy({} as ControlRepository, {
    get(_target, property) {
      if (property === "getRun") return async () => pausedRun;
      if (property === "transitionRun") {
        return async () => {
          transitioned = true;
          return { ...pausedRun, status: "PENDING" as const, controlVersion: 2 };
        };
      }
      if (property === "close") return async () => undefined;
      return async () => {
        throw new Error(`Unexpected repository call: ${String(property)}`);
      };
    },
  });
  const tracker = queueTracker();
  const app = await buildControlApi({
    repository,
    runQueue: tracker.queue,
    authRequired: false,
    runExecutionEnabled: false,
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/runs/${RUN_ID}/actions`,
      payload: {
        action: "resume",
        expectedStatus: "PAUSED",
        expectedControlVersion: 1,
      },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "RUN_EXECUTION_DISABLED");
    assert.equal(transitioned, false);
    assert.equal(tracker.wasEnqueued(), false);
  } finally {
    await app.close();
  }
});

test("disabled policy still permits non-enqueueing cancellation", async () => {
  let transitioned = false;
  const runningRun = createRun("RUNNING");
  const cancelledRun: RunRecord = {
    ...runningRun,
    status: "CANCELLED",
    controlVersion: 2,
    cancelledAt: NOW,
  };
  const repository = new Proxy({} as ControlRepository, {
    get(_target, property) {
      if (property === "getRun") return async () => runningRun;
      if (property === "transitionRun") {
        return async () => {
          transitioned = true;
          return cancelledRun;
        };
      }
      if (property === "close") return async () => undefined;
      return async () => {
        throw new Error(`Unexpected repository call: ${String(property)}`);
      };
    },
  });
  const tracker = queueTracker();
  const app = await buildControlApi({
    repository,
    runQueue: tracker.queue,
    authRequired: false,
    runExecutionEnabled: false,
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/runs/${RUN_ID}/actions`,
      payload: {
        action: "cancel",
        expectedStatus: "RUNNING",
        expectedControlVersion: 1,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "CANCELLED");
    assert.equal(transitioned, true);
    assert.equal(tracker.wasEnqueued(), false);
  } finally {
    await app.close();
  }
});

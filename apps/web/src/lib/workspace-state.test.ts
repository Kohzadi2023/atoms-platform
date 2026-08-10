import assert from "node:assert/strict";
import test from "node:test";

import type { RunEventEnvelope } from "@atoms/contracts";

import {
  availableRunActions,
  createWorkspaceProjection,
  isSafePreviewUrl,
  reduceRunEvent,
} from "./workspace-state.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";

test("event projection orders agent work and records deterministic validation", () => {
  let state = createWorkspaceProjection();
  state = reduceRunEvent(
    state,
    event(2, "task.started", {
      taskId: "task-1",
      agent: "Emma",
      ordinal: 2,
      attempt: 1,
    }),
  );
  state = reduceRunEvent(
    state,
    event(3, "task.progress", {
      version: "v1",
      phase: "sandbox-validation",
      sandboxSessionId: "00000000-0000-4000-8000-000000000002",
      ordinal: 1,
      step: "typecheck",
      status: "SUCCEEDED",
      exitCode: 0,
      durationMs: 42,
      stdout: "clean",
      stderr: "",
    }),
  );

  assert.equal(state.activeAgent, "Emma");
  assert.equal(state.tasks.Emma.status, "running");
  assert.equal(state.validations[0]?.step, "typecheck");
  assert.equal(state.validations[0]?.exitCode, 0);
});

test("Phase 4 agents and scoped approvals remain visible after event replay", () => {
  let state = createWorkspaceProjection();
  state = reduceRunEvent(
    state,
    event(1, "task.started", {
      taskId: "00000000-0000-4000-8000-000000000010",
      agent: "Sarah",
      ordinal: 6,
      attempt: 1,
    }),
  );
  state = reduceRunEvent(
    state,
    event(2, "task.completed", {
      taskId: "00000000-0000-4000-8000-000000000010",
      agent: "Sarah",
      ordinal: 6,
      attempt: 1,
    }),
  );
  state = reduceRunEvent(
    state,
    event(3, "task.started", {
      taskId: "00000000-0000-4000-8000-000000000011",
      agent: "Adrian",
      ordinal: 7,
      attempt: 1,
    }),
  );
  state = reduceRunEvent(
    state,
    event(4, "approval.required", {
      version: "v1",
      scope: "content",
      reason: "Approve content variants before applying copy changes",
    }),
  );

  assert.equal(state.tasks.Sarah.status, "completed");
  assert.equal(state.tasks.Adrian.status, "waiting");
  assert.equal(state.approvalScope, "content");
  assert.match(state.approvalReason ?? "", /content variants/);

  state = reduceRunEvent(
    state,
    event(5, "run.status_changed", {
      from: "PENDING",
      to: "RUNNING",
    }),
  );
  assert.equal(state.approvalReason, undefined);
  assert.equal(state.approvalScope, undefined);
});

test("database projection ignores an older fenced operation event", () => {
  const base = createWorkspaceProjection();
  const newer = reduceRunEvent(
    base,
    event(1, "integration.status_changed", databasePayload(3, "READY")),
  );
  const stale = reduceRunEvent(
    newer,
    event(2, "integration.status_changed", databasePayload(2, "FAILED")),
  );
  assert.equal(stale.database?.operationVersion, 3);
  assert.equal(stale.database?.status, "READY");
});

test("run actions are fail-closed for terminal states", () => {
  assert.deepEqual(availableRunActions("RUNNING"), ["pause", "cancel"]);
  assert.deepEqual(availableRunActions("PAUSED"), [
    "approve",
    "resume",
    "cancel",
  ]);
  assert.deepEqual(availableRunActions("COMPLETED"), []);
});

test("preview URLs require the configured signed origin boundary", () => {
  assert.equal(
    isSafePreviewUrl(
      "https://run-abc.preview.example.com/",
      "preview.example.com",
    ),
    true,
  );
  assert.equal(
    isSafePreviewUrl("https://preview.example.com.attacker.test/", "preview.example.com"),
    false,
  );
  assert.equal(
    isSafePreviewUrl("http://run.preview.example.com/", "preview.example.com"),
    false,
  );
  assert.equal(
    isSafePreviewUrl("http://run.preview.localhost/", "preview.localhost"),
    true,
  );
});

function event(
  sequence: number,
  eventType: RunEventEnvelope["eventType"],
  payload: RunEventEnvelope["payload"],
): RunEventEnvelope {
  return {
    sequence,
    runId: RUN_ID,
    eventType,
    payload,
    occurredAt: new Date(sequence * 1_000).toISOString(),
  };
}

function databasePayload(operationVersion: number, status: "READY" | "FAILED") {
  return {
    version: "v1" as const,
    integration: "generated-database" as const,
    databaseInstanceId: "00000000-0000-4000-8000-000000000003",
    operationId: "00000000-0000-4000-8000-000000000004",
    operationVersion,
    provider: "SUPABASE" as const,
    status,
  };
}

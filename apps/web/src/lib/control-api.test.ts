import assert from "node:assert/strict";
import test from "node:test";

import type { RunResponse } from "@atoms/contracts";

import { ControlApiClient } from "./control-api.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-08-09T20:00:00.000Z";

test("createRun sends the shared idempotency header and payload", async (context) => {
  const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return jsonResponse(runResponse());
  };

  const client = new ControlApiClient({ baseUrl: "http://control.test/" });
  await client.createRun(
    PROJECT_ID,
    "Build a portal",
    "web-run-request-0001",
    ["00000000-0000-4000-8000-000000000003"],
  );

  assert.equal(requests.length, 1);
  assert.equal(
    new Headers(requests[0]?.init.headers).get("idempotency-key"),
    "web-run-request-0001",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    prompt: "Build a portal",
    attachmentIds: ["00000000-0000-4000-8000-000000000003"],
  });
});

test("approve action sends its scope and concurrency preconditions", async (context) => {
  let body: unknown;
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init = {}) => {
    body = JSON.parse(String(init.body));
    return jsonResponse(runResponse({ status: "PENDING", controlVersion: 5 }));
  };

  const client = new ControlApiClient({ baseUrl: "http://control.test" });
  await client.runAction(RUN_ID, {
    action: "approve",
    approvalScope: "content",
    expectedStatus: "PAUSED",
    expectedControlVersion: 4,
    reason: "Approved content in the workspace",
  });

  assert.deepEqual(body, {
    action: "approve",
    approvalScope: "content",
    expectedStatus: "PAUSED",
    expectedControlVersion: 4,
    reason: "Approved content in the workspace",
  });
});

function runResponse(
  patch: Partial<RunResponse> = {},
): RunResponse {
  return {
    id: RUN_ID,
    workspaceId: "00000000-0000-4000-8000-000000000004",
    projectId: PROJECT_ID,
    status: "PAUSED",
    prompt: "Build a portal",
    eventSequence: 3,
    controlVersion: 4,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    pausedAt: NOW,
    completedAt: null,
    cancelledAt: null,
    ...patch,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

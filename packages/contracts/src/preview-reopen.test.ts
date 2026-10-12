import assert from "node:assert/strict";
import test from "node:test";

import {
  PREVIEW_REOPEN_QUEUE_NAME,
  PreviewReopenJobSchema,
  PreviewReopenResponseSchema,
} from "./preview-reopen.js";

const ids = {
  projectId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
};

test("the reopen queue has its own name, apart from the run queue", () => {
  assert.equal(PREVIEW_REOPEN_QUEUE_NAME, "preview-reopens");
});

test("a reopen job carries exactly the project, workspace and run ids", () => {
  assert.deepEqual(PreviewReopenJobSchema.parse(ids), ids);
  assert.equal(PreviewReopenJobSchema.safeParse({ ...ids, extra: 1 }).success, false);
  assert.equal(PreviewReopenJobSchema.safeParse({ ...ids, runId: "nope" }).success, false);
});

test("the API answers a reopen request with REQUESTED and the run that will receive the event", () => {
  const response = { status: "REQUESTED", runId: ids.runId };
  assert.deepEqual(PreviewReopenResponseSchema.parse(response), response);
  assert.equal(PreviewReopenResponseSchema.safeParse({ ...response, status: "READY" }).success, false);
});

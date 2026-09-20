import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { createThrottledLogger } from "./throttled-log.js";

function harness(intervalMs = 60_000, maxKeys?: number) {
  const lines: unknown[][] = [];
  let clock = 1_000_000;
  const logError = createThrottledLogger({
    write: (...args) => lines.push(args),
    intervalMs,
    now: () => clock,
    ...(maxKeys === undefined ? {} : { maxKeys }),
  });
  return {
    lines,
    logError,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const crossslot = () =>
  new Error("CROSSSLOT Keys in request don't hash to the same slot (command='evalsha')");

test("the first occurrence is printed in full, with its error object", () => {
  const { lines, logError } = harness();
  const error = crossslot();

  logError("Orchestrator worker error", error);

  assert.deepEqual(lines, [["Orchestrator worker error", error]]);
});

test("a flood of the same error inside the window prints nothing more", () => {
  const { lines, logError, advance } = harness();
  for (let index = 0; index < 100_000; index += 1) {
    logError("Orchestrator worker error", crossslot());
    if (index % 1_000 === 0) advance(1);
  }

  assert.equal(lines.length, 1);
});

test("after the window one short summary with the count replaces the stack trace", () => {
  const { lines, logError, advance } = harness(60_000);
  logError("Attachment worker error", crossslot());
  for (let index = 0; index < 500; index += 1) logError("Attachment worker error", crossslot());
  advance(60_000);
  logError("Attachment worker error", crossslot());

  assert.equal(lines.length, 2);
  const summary = String(lines[1]?.[0]);
  assert.match(summary, /Attachment worker error: Error: CROSSSLOT/);
  assert.match(summary, /repeated 500 more times in the last 60s/);
  assert.equal(lines[1]?.length, 1, "no error object, so no stack trace");
});

test("a different error is never hidden behind an earlier one", () => {
  const { lines, logError } = harness();
  logError("Orchestrator worker error", crossslot());
  logError("Orchestrator worker error", new Error("MOVED 9134 10.40.1.4:8501"));
  logError("Attachment worker error", crossslot());

  assert.equal(lines.length, 3);
});

test("a job id is context, not part of the key, so one failure on many jobs is one line", () => {
  const { lines, logError } = harness();
  const error = new Error("provider budget disabled");
  for (let job = 0; job < 50; job += 1) logError("Orchestrator job failed", error, { jobId: `job-${String(job)}` });

  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], ["Orchestrator job failed", { jobId: "job-0" }, error]);
});

test("a repeat after a quiet window is printed in full again", () => {
  const { lines, logError, advance } = harness(60_000);
  logError("Database operation worker error", crossslot());
  advance(120_000);
  logError("Database operation worker error", crossslot());

  assert.equal(lines.length, 2);
  assert.equal(lines[1]?.length, 2, "a real occurrence, not a summary");
});

test("memory is bounded when every message is different", () => {
  const { lines, logError } = harness(60_000, 5);
  for (let index = 0; index < 50; index += 1) logError("x", new Error(`unique ${String(index)}`));

  assert.equal(lines.length, 50);
});

test("non-Error values are handled", () => {
  const { lines, logError } = harness();
  logError("worker error", "plain string");
  logError("worker error", "plain string");
  logError("worker error", undefined);

  assert.equal(lines.length, 2);
});

test("the worker routes every queue and job error through the throttled logger", async () => {
  const source = await readFile(resolve(process.cwd(), "src/main.ts"), "utf8");

  assert.match(source, /createThrottledLogger\(\)/u);
  // Queue error handlers and failed-job handlers must not print unthrottled.
  assert.doesNotMatch(source, /console\.error\("[A-Za-z ]+ worker error"/u);
  assert.doesNotMatch(source, /console\.error\("[A-Za-z ]+ job failed"/u);
  assert.doesNotMatch(source, /console\.error\("[A-Za-z ]+ reconciliation job failed"/u);
});

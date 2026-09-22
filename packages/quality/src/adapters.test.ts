import assert from "node:assert/strict";
import test from "node:test";

import type { AgentProjectFile, EmmaOutput } from "@atoms/agents";
import type { ValidationStepReport } from "@atoms/sandbox-provider";

import {
  createAcceptanceSnapshot, evidenceFromAcceptanceRun, evidenceFromValidationStep, fingerprintProjectSnapshot,
  QualityInputError,
} from "./index.js";
import { scope, uuid } from "./test-fixtures.js";

const emma: EmmaOutput = {
  productName: "Workspace", problemStatement: "Members need their own workspace.",
  targetUsers: ["Members"], nonGoals: [], assumptions: [],
  userStories: [{
    id: "US-001", role: "member", goal: "view a workspace", benefit: "access my files",
    acceptanceCriteria: ["Own workspace is accessible.", "Foreign workspace is inaccessible."],
  }],
};

function step(): ValidationStepReport {
  return {
    ordinal: 5, name: "test", command: "pnpm test",
    startedAt: "2026-09-13T23:59:50.000Z", completedAt: "2026-09-14T00:00:00.000Z",
    result: { exitCode: 0, durationMs: 10_000, stdout: "private-log-canary", stderr: "private-error-canary" },
  };
}

test("current EmmaOutput shape maps to stable story and one-based criterion references", () => {
  const snapshot = createAcceptanceSnapshot({ scope, taskId: uuid(4), taskAttempt: 0, output: emma });
  assert.deepEqual(snapshot.criteria, [
    { id: "US-001:1", text: "Own workspace is accessible." },
    { id: "US-001:2", text: "Foreign workspace is inaccessible." },
  ]);
  assert.equal(snapshot.taskId, uuid(4));
  assert.equal(snapshot.taskAttempt, 0);
});

test("ambiguous duplicate story IDs fail before creating acceptance references", () => {
  assert.throws(() => createAcceptanceSnapshot({ scope, taskId: uuid(4), taskAttempt: 0, output: {
    ...emma, userStories: [...emma.userStories, emma.userStories[0]],
  } }), QualityInputError);
});

test("a retried task keeps its id but a later attempt's snapshot is distinct from an earlier one", () => {
  const first = createAcceptanceSnapshot({ scope, taskId: uuid(4), taskAttempt: 0, output: emma });
  const revisedEmma: EmmaOutput = {
    ...emma,
    userStories: [{ ...emma.userStories[0]!, acceptanceCriteria: ["Own workspace is accessible.", "Revised: an admin can archive the workspace."] }],
  };
  const second = createAcceptanceSnapshot({ scope, taskId: uuid(4), taskAttempt: 1, output: revisedEmma });
  // Same task id and the same positional criterion ids, but the second attempt's criterion text
  // has genuinely changed and its attempt number reflects that.
  assert.equal(first.taskId, second.taskId);
  assert.deepEqual(first.criteria.map((c) => c.id), second.criteria.map((c) => c.id));
  assert.notEqual(first.taskAttempt, second.taskAttempt);
  assert.notDeepEqual(first.criteria, second.criteria);
});

for (const name of ["lint", "typecheck", "test", "build"] as const) {
  test(`current ${name} ValidationStepReport converts without copying logs or asserting acceptance`, () => {
    const report = evidenceFromValidationStep({ scope, commandId: uuid(10), step: { ...step(), name } });
    assert.equal(report?.kind, name.toUpperCase());
    assert.equal(report?.status, "PASSED");
    assert.deepEqual(report?.criterionIds, []);
    assert.equal(report?.acceptanceTaskId, null);
    assert.equal(report?.sourceArtifactId, uuid(10));
    assert.ok(!JSON.stringify(report).includes("private-"));
  });
}

test("command error overrides exit code zero; nonzero is failed", () => {
  const command: ValidationStepReport = {
    ...step(), result: { ...step().result, error: "private-error-canary" },
  };
  const report = evidenceFromValidationStep({ scope, commandId: uuid(10), step: command });
  assert.equal(report?.status, "ERROR");
  assert.ok(!JSON.stringify(report).includes("private-error-canary"));
  assert.equal(evidenceFromValidationStep({ scope, commandId: uuid(10), step: {
    ...step(), result: { ...step().result, exitCode: 1 },
  } })?.status, "FAILED");
});

test("install and preview checks are not mislabeled as quality or acceptance evidence", () => {
  for (const name of ["install", "prisma-validate", "preview-start", "preview-health"] as const) {
    assert.equal(evidenceFromValidationStep({ scope, commandId: uuid(10), step: { ...step(), name } }), null);
  }
});

test("malformed command interval cannot become passing evidence", () => {
  assert.throws(() => evidenceFromValidationStep({ scope, commandId: uuid(10), step: {
    ...step(), startedAt: "2026-09-14T00:05:00.000Z",
  } }), QualityInputError);
});

const files: readonly AgentProjectFile[] = [
  { path: "src/index.ts", version: 2, content: "export const value = 1;" },
  { path: "package.json", version: 1, content: "{}" },
];

test("snapshot fingerprint is order-independent and binds path, version and exact bytes", () => {
  const hash = fingerprintProjectSnapshot(files);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(fingerprintProjectSnapshot([...files].reverse()), hash);
  for (const change of [{ path: "src/other.ts" }, { version: 3 }, { content: "export const value = 2;" }]) {
    assert.notEqual(fingerprintProjectSnapshot([{ ...files[0], ...change }, files[1]]), hash);
  }
});

const acceptanceInput = (stdout: string) => ({
  scope, sourceArtifactId: uuid(20), acceptanceTaskId: uuid(4), acceptanceTaskAttempt: 0,
  completedAt: "2026-09-14T00:00:20.000Z",
  criterionIdsByScenario: { "home-loads": ["US-001:1", "US-001:2"] },
  stdout,
});

test("G3: a scenario mapped to criterion ids becomes ACCEPTANCE evidence for exactly those ids", () => {
  const evidence = evidenceFromAcceptanceRun(acceptanceInput(
    JSON.stringify({ ok: true, results: [{ scenario: "home-loads", status: "PASSED", durationMs: 120 }] }),
  ));
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.kind, "ACCEPTANCE");
  assert.equal(evidence[0]?.status, "PASSED");
  assert.equal(evidence[0]?.sourceArtifactId, uuid(20));
  assert.equal(evidence[0]?.acceptanceTaskId, uuid(4));
  assert.equal(evidence[0]?.completedAt, "2026-09-14T00:00:20.000Z");
  assert.deepEqual(evidence[0]?.criterionIds, ["US-001:1", "US-001:2"]);
});

test("G3: a scenario absent from the map, or mapped to an empty list, produces no evidence", () => {
  const stdout = JSON.stringify({
    ok: false,
    results: [
      { scenario: "unmapped-scenario", status: "PASSED", durationMs: 50 },
      { scenario: "home-loads", status: "FAILED", durationMs: 90 },
    ],
  });
  const evidence = evidenceFromAcceptanceRun({
    ...acceptanceInput(stdout),
    criterionIdsByScenario: { "unmapped-scenario": [], "home-loads": ["US-001:1"] },
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.status, "FAILED");
  assert.deepEqual(evidence[0]?.criterionIds, ["US-001:1"]);
});

test("G3: only the last stdout line is read, so preceding log noise is ignored", () => {
  const stdout = [
    "installing dependencies...",
    "warning: something unrelated",
    JSON.stringify({ ok: true, results: [{ scenario: "home-loads", status: "PASSED", durationMs: 10 }] }),
  ].join("\n");
  assert.equal(evidenceFromAcceptanceRun(acceptanceInput(stdout)).length, 1);
});

test("G3: missing, malformed or schema-invalid stdout yields no evidence and never throws", () => {
  for (const stdout of [
    "", "not json at all", JSON.stringify({ ok: true }),
    JSON.stringify({ ok: true, results: [] }),
    JSON.stringify({ ok: true, results: [{ scenario: "home-loads", status: "MAYBE", durationMs: 1 }] }),
  ]) {
    assert.deepEqual(evidenceFromAcceptanceRun(acceptanceInput(stdout)), []);
  }
});

test("snapshot fingerprint rejects duplicate paths, traversal, empty snapshots and missing versions", () => {
  for (const invalid of [
    [], [files[0], files[0]], [{ ...files[0], path: "../index.ts" }],
    [{ ...files[0], path: "src/./index.ts" }], [{ ...files[0], version: 0 }],
    [{ path: "index.ts", content: "export {};" }],
  ]) assert.throws(() => fingerprintProjectSnapshot(invalid), QualityInputError);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  BASELINE_CHECKS, evaluateRelease, QualityInputError, ReleaseAssessmentSchema,
  type QualityEvaluationInput, type QualityIssue, type QualityScope,
} from "./index.js";
import { fixture, uuid } from "./test-fixtures.js";

function blocked(input: unknown, code: QualityIssue["code"]): void {
  const result = evaluateRelease(input);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.issues.some((issue) => issue.code === code), JSON.stringify(result.issues));
}

test("complete current evidence yields an observe-only READY assessment with per-criterion trace", () => {
  const result = evaluateRelease(fixture());
  assert.equal(result.status, "READY");
  assert.equal(result.mode, "OBSERVE_ONLY");
  assert.deepEqual(result.issues, []);
  assert.equal(result.checks.length, 9);
  assert.equal(result.traceToAcceptance.length, 2);
  assert.deepEqual(result.traceToAcceptance[1], {
    criterionId: "US-001:2", status: "PASSED", evidenceIds: [uuid(31)],
  });
  assert.ok(ReleaseAssessmentSchema.safeParse(result).success);
});

test("empty evidence never yields vacuous success", () => {
  const input = fixture();
  input.evidence = [];
  const result = evaluateRelease(input);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.checks.filter((item) => item.status === "BLOCKED").length, 9);
  assert.equal(result.traceToAcceptance.filter((item) => item.status === "BLOCKED").length, 2);
});

test("all checks passing cannot substitute for missing acceptance output", () => {
  const input = fixture();
  input.acceptance = null;
  input.evidence = input.evidence.filter((item) => item.kind !== "ACCEPTANCE");
  blocked(input, "MISSING_ACCEPTANCE");
});

test("a passing generic test report cannot establish acceptance coverage", () => {
  const input = fixture();
  input.evidence = input.evidence.filter((item) => item.kind !== "ACCEPTANCE");
  blocked(input, "MISSING_CRITERION_EVIDENCE");
});

test("one uncovered acceptance criterion blocks an otherwise complete assessment", () => {
  const input = fixture();
  input.evidence = input.evidence.filter((item) => item.id !== uuid(31));
  const result = evaluateRelease(input);
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.issues, [{ code: "MISSING_CRITERION_EVIDENCE", criterionId: "US-001:2" }]);
});

for (const kind of fixture().policy.requiredChecks) {
  test(`missing ${kind} evidence blocks the standard release policy`, () => {
    const input = fixture();
    input.evidence = input.evidence.filter((item) => item.kind !== kind);
    blocked(input, "MISSING_CHECK");
  });
}

for (const status of ["FAILED", "ERROR", "SKIPPED"] as const) {
  for (const kind of ["TEST", "ACCEPTANCE"] as const) {
    test(`${status} ${kind} evidence cannot pass`, () => {
      const input = fixture();
      input.evidence.find((item) => item.kind === kind)!.status = status;
      blocked(input, "EVIDENCE_NOT_PASSED");
    });
  }
}

const mismatches: Partial<QualityScope>[] = [
  { workspaceId: uuid(501) }, { projectId: uuid(502) }, { runId: uuid(503) },
  { controlVersion: 1 }, { attempt: 2 }, { snapshotSha256: "b".repeat(64) },
];
for (const mismatch of mismatches) {
  const field = Object.keys(mismatch)[0];
  test(`evidence for another ${String(field)} is not accepted`, () => {
    const input = fixture();
    input.evidence[0]!.scope = { ...input.scope, ...mismatch };
    blocked(input, "EVIDENCE_SCOPE_MISMATCH");
  });
  test(`acceptance output for another ${String(field)} is not accepted`, () => {
    const input = fixture();
    input.acceptance!.scope = { ...input.scope, ...mismatch };
    blocked(input, "ACCEPTANCE_SCOPE_MISMATCH");
  });
}

test("wrong acceptance task and invented criterion references are blocked", () => {
  const input = fixture();
  const evidence = input.evidence.find((item) => item.kind === "ACCEPTANCE")!;
  evidence.acceptanceTaskId = uuid(600);
  blocked(input, "ACCEPTANCE_TASK_MISMATCH");
  evidence.acceptanceTaskId = input.acceptance!.taskId;
  evidence.criterionIds = ["US-999:1"];
  blocked(input, "UNKNOWN_CRITERION");
});

test("duplicate evidence IDs block even identical success claims", () => {
  const input = fixture();
  input.evidence.push(structuredClone(input.evidence[0]!));
  blocked(input, "DUPLICATE_EVIDENCE");
});

test("a success cannot mask contradictory failure with the same or a different evidence ID", () => {
  for (const sameId of [true, false]) {
    const input = fixture();
    input.evidence.push({
      ...input.evidence[0]!, id: sameId ? input.evidence[0]!.id : uuid(700), status: "FAILED",
    });
    blocked(input, "EVIDENCE_NOT_PASSED");
  }
});

test("irrelevant foreign evidence is flagged instead of silently ignored", () => {
  const input = fixture();
  input.evidence.push({ ...input.evidence[0]!, id: uuid(701), scope: { ...input.scope, runId: uuid(702) } });
  blocked(input, "EVIDENCE_SCOPE_MISMATCH");
});

test("evidence age uses only the supplied evaluation time and exact inclusive limit", () => {
  const input = fixture();
  input.policy.maxEvidenceAgeSeconds = 60;
  assert.equal(evaluateRelease(input).status, "READY");
  input.evaluatedAt = "2026-09-14T00:01:00.001Z";
  blocked(input, "EVIDENCE_TOO_OLD");
  input.evaluatedAt = "2026-09-13T23:59:59.999Z";
  blocked(input, "EVIDENCE_FROM_FUTURE");
});

test("narrower explicit policy still requires baseline checks and acceptance", () => {
  const input = fixture();
  input.policy.requiredChecks = [...BASELINE_CHECKS];
  input.evidence = input.evidence.filter((item) => item.kind === "ACCEPTANCE" ||
    input.policy.requiredChecks.some((kind) => kind === item.kind));
  assert.equal(evaluateRelease(input).status, "READY");
  input.policy.requiredChecks = ["TEST"];
  assert.throws(() => evaluateRelease(input), QualityInputError);
});

test("omitting an optional failed check from policy does not erase a submitted failure", () => {
  const input = fixture();
  input.policy.requiredChecks = [...BASELINE_CHECKS];
  input.evidence.find((item) => item.kind === "SECURITY")!.status = "FAILED";
  blocked(input, "EVIDENCE_NOT_PASSED");
});

test("input and evidence order do not affect the deterministic result", () => {
  const input = fixture();
  input.evidence[0]!.status = "FAILED";
  const expected = evaluateRelease(input);
  input.evidence.reverse();
  input.policy.requiredChecks.reverse();
  input.acceptance!.criteria.reverse();
  const before = structuredClone(input);
  function freeze(value: unknown): void {
    if (typeof value === "object" && value !== null) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  freeze(input);
  assert.deepEqual(evaluateRelease(input), expected);
  assert.deepEqual(input, before);
});

test("assessment carries references and diagnostics, not criterion text or arbitrary raw output", () => {
  const input = fixture();
  input.acceptance!.criteria[0]!.text = "private-content-canary";
  assert.ok(!JSON.stringify(evaluateRelease(input)).includes("private-content-canary"));
  assert.throws(() => evaluateRelease({ ...input, stdout: "private-content-canary" }),
    (error: unknown) => error instanceof QualityInputError && error.message === "QUALITY_INPUT_INVALID");
});

const invalidCases: [string, (input: QualityEvaluationInput) => unknown][] = [
  ["missing policy", (input) => ({ ...input, policy: undefined })],
  ["invalid timestamp", (input) => ({ ...input, evaluatedAt: "not-a-time" })],
  ["duplicate checks", (input) => ({ ...input, policy: { ...input.policy, requiredChecks: [...BASELINE_CHECKS, "TEST"] } })],
  ["duplicate criteria", (input) => ({ ...input, acceptance: { ...input.acceptance, criteria: [input.acceptance!.criteria[0], input.acceptance!.criteria[0]] } })],
  ["empty criteria", (input) => ({ ...input, acceptance: { ...input.acceptance, criteria: [] } })],
  ["invented kind", (input) => ({ ...input, evidence: [{ ...input.evidence[0], kind: "AUTOMATIC_APPROVAL" }] })],
  ["generic test acceptance claim", (input) => ({ ...input, evidence: [{ ...input.evidence[0], criterionIds: ["US-001:1"], acceptanceTaskId: uuid(4) }] })],
  ["missing acceptance task", (input) => ({ ...input, evidence: [{ ...input.evidence.at(-1), acceptanceTaskId: null }] })],
  ["duplicate criterion references", (input) => ({ ...input, evidence: [{ ...input.evidence.at(-1), criterionIds: ["US-001:1", "US-001:1"] }] })],
  ["legacy cuid scope", (input) => ({ ...input, scope: { ...input.scope, runId: "cuid-is-not-a-run-uuid" } })],
  ["fractional attempt", (input) => ({ ...input, scope: { ...input.scope, attempt: 1.5 } })],
];
for (const [name, invalidate] of invalidCases) {
  test(`invalid ${name} is rejected without producing an assessment`, () => {
    assert.throws(() => evaluateRelease(invalidate(fixture())), QualityInputError);
  });
}

test("output schema rejects a READY label on blocked or incomplete coverage", () => {
  const input = fixture();
  input.evidence = [];
  assert.equal(ReleaseAssessmentSchema.safeParse({ ...evaluateRelease(input), status: "READY" }).success, false);
  const ready = evaluateRelease(fixture());
  assert.equal(ReleaseAssessmentSchema.safeParse({ ...ready, checks: [] }).success, false);
  assert.equal(ReleaseAssessmentSchema.safeParse({ ...ready, traceToAcceptance: [] }).success, false);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Phase3StagingGateNameSchema } from "../packages/contracts/dist/index.js";
import { finalizationInputs, finalizeCostEvidence, verifySourceRun } from "./finalize-phase3-cost.mjs";

const env = {
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "atoms/platform", GITHUB_ACTOR: "operator",
  PHASE3_SOURCE_RUN_ID: "100", PHASE3_SOURCE_RUN_ATTEMPT: "2",
  PHASE3_STAGING_CHANGE_TICKET: "GH-ISSUE-14", PHASE3_STAGING_MEASURED_COST_CAD: "0.25",
  PHASE3_MEASUREMENT_SOURCE_SHA256: "b".repeat(64),
  PHASE3_COST_CONFIRMATION: "I_ATTEST_ACTUAL_PHASE3_COST_AFTER_CLEANUP",
};
const input = finalizationInputs(env);
const recordedAt = new Date("2026-09-13T14:00:00Z");
function fixture() {
  const evidence = {
    version: "phase3-provider-staging.v2",
    scenarioId: "00000000-0000-4000-8000-000000000046",
    changeTicket: "GH-ISSUE-14", environment: "staging", result: "AWAITING_COST",
    startedAt: "2026-09-13T12:01:00Z", completedAt: "2026-09-13T12:10:00Z",
    externalResourceFingerprint: "d".repeat(64),
    managedResourcesBefore: 1, managedResourcesAfter: 1, createdResources: 1, deletedResources: 1,
    workflowRun: { repository: "atoms/platform", runId: "100", runAttempt: 2, commitSha: "a".repeat(40) },
    approvedBudgetCadMicros: 1_000_000, measuredVariableCostCadMicros: null, costMeasurement: null,
    variableCostTargetCadMicros: 4_000_000,
    gates: Phase3StagingGateNameSchema.options.map((name) => ({ name,
      status: name === "variable_cost" ? "PENDING" : "PASSED", durationMs: 0, details: {} })),
    errors: [],
  };
  const metadata = {
    run: {
      id: 100, run_attempt: 2, repository: { full_name: "atoms/platform" }, head_repository: { full_name: "atoms/platform" },
      head_sha: "a".repeat(40), event: "workflow_dispatch", head_branch: "main", path: ".github/workflows/phase3-staging.yml",
      status: "completed", conclusion: "failure", run_started_at: "2026-09-13T12:00:00Z", updated_at: "2026-09-13T12:11:00Z",
    },
    jobs: { total_count: 3, jobs: [
      { name: "preflight", run_attempt: 2, status: "completed", conclusion: "success" },
      { name: "migration-and-durability", run_attempt: 2, status: "completed", conclusion: "success" },
      { name: "provider-exit", run_attempt: 2, status: "completed", conclusion: "failure", steps: [
        { name: "Provision, migrate, verify, and clean up the staging database", conclusion: "success" },
        { name: "Stop ephemeral Vault", conclusion: "success" },
        { name: "Await cost finalization", conclusion: "failure" },
      ] },
    ] },
  };
  return { evidence, metadata };
}

test("actual cost finalization binds the receipt, immutable source bytes, actor and source run", () => {
  const { evidence, metadata } = fixture();
  const source = JSON.stringify(evidence);
  const final = finalizeCostEvidence(source, input, metadata, recordedAt);
  assert.equal(final.result, "PASSED");
  assert.equal(final.approvedBudgetCadMicros, 1_000_000);
  assert.equal(final.measuredVariableCostCadMicros, 250_000);
  assert.equal(final.costMeasurement.sourceEvidenceSha256, createHash("sha256").update(source).digest("hex"));
  assert.equal(final.costMeasurement.measurementSourceSha256, env.PHASE3_MEASUREMENT_SOURCE_SHA256);
  assert.equal(final.costMeasurement.recordedBy, "operator");
  assert.equal(evidence.result, "AWAITING_COST");
  assert.equal(evidence.measuredVariableCostCadMicros, null);
});

test("actual cost must respect the selected budget even when below CAD 4", () => {
  const { evidence, metadata } = fixture();
  const final = finalizeCostEvidence(JSON.stringify(evidence), { ...input, measuredCadMicros: 1_000_001 }, metadata, recordedAt);
  assert.equal(final.result, "FAILED");
  assert.equal(final.deletedResources, 1);
  assert.equal(final.gates.find((gate) => gate.name === "variable_cost").status, "FAILED");
  assert.equal(final.errors[0].code, "ACTUAL_COST_BUDGET_EXCEEDED");
});

test("zero is accepted only as an explicitly supplied actual measurement; the approved budget is retained", () => {
  const { evidence, metadata } = fixture();
  const final = finalizeCostEvidence(JSON.stringify(evidence), finalizationInputs({ ...env, PHASE3_STAGING_MEASURED_COST_CAD: "0" }), metadata, recordedAt);
  assert.equal(final.result, "PASSED");
  assert.equal(final.measuredVariableCostCadMicros, 0);
  assert.equal(final.approvedBudgetCadMicros, 1_000_000);
});

test("missing, malformed or unattested measurements fail before evidence can be finalized", () => {
  for (const value of [undefined, "", "-1", "0.0000001", "1e-3", "NaN", " 1", "01", "9007199254740992"]) {
    assert.throws(() => finalizationInputs({ ...env, PHASE3_STAGING_MEASURED_COST_CAD: value }));
  }
  for (const changed of [
    { PHASE3_COST_CONFIRMATION: "yes" }, { PHASE3_MEASUREMENT_SOURCE_SHA256: "receipt" },
    { GITHUB_EVENT_NAME: "push" }, { GITHUB_REF: "refs/heads/topic" }, { PHASE3_SOURCE_RUN_ID: "../2" },
    { PHASE3_SOURCE_RUN_ATTEMPT: "2x" },
  ]) assert.throws(() => finalizationInputs({ ...env, ...changed }));
});

test("failed cleanup, conflicting evidence and unbound evidence cannot be promoted to a pass", () => {
  const mutations = [
    (e) => { e.deletedResources = 0; },
    (e) => { e.managedResourcesAfter = 2; },
    (e) => { e.result = "FAILED"; },
    (e) => { e.workflowRun.runAttempt = 1; },
    (e) => { e.workflowRun.commitSha = "c".repeat(40); },
    (e) => { e.workflowRun = null; },
    (e) => { e.changeTicket = "OTHER"; },
    (e) => { e.approvedBudgetCadMicros = 4_000_001; },
    (e) => { e.measuredVariableCostCadMicros = 1; },
    (e) => { e.gates[0] = e.gates[1]; },
    (e) => { e.gates[0].details = { url: "postgresql://user:secret@example.test/db" }; },
  ];
  for (const mutate of mutations) {
    const { evidence, metadata } = fixture();
    mutate(evidence);
    assert.throws(() => finalizeCostEvidence(JSON.stringify(evidence), input, metadata, recordedAt));
  }
});

test("wrong workflow, fork, rerun, partial jobs and other source failures are rejected", () => {
  const mutations = [
    (m) => { m.run.head_repository.full_name = "other/platform"; },
    (m) => { m.run.run_attempt = 3; },
    (m) => { m.run.path = ".github/workflows/ci.yml"; },
    (m) => { m.run.status = "in_progress"; },
    (m) => { m.run.head_branch = "topic"; },
    (m) => { m.jobs.total_count = 4; },
    (m) => { m.jobs.jobs[0].conclusion = "failure"; },
    (m) => { m.jobs.jobs[2].steps[0].conclusion = "failure"; },
    (m) => { m.jobs.jobs[2].steps[2].name = "Provider error"; },
  ];
  for (const mutate of mutations) {
    const { metadata } = fixture();
    mutate(metadata);
    assert.throws(() => verifySourceRun(metadata, input));
  }
});

test("cost cannot be recorded before source completion or finalized a second time", () => {
  const { evidence, metadata } = fixture();
  assert.throws(() => finalizeCostEvidence(JSON.stringify(evidence), input, metadata, new Date(evidence.completedAt)));
  const final = finalizeCostEvidence(JSON.stringify(evidence), input, metadata, recordedAt);
  assert.throws(() => finalizeCostEvidence(JSON.stringify(final), input, metadata, recordedAt));
});

test("cost workflow has no provider secrets or execution commands, and the lifecycle cannot report a final pass", () => {
  const cost = readFileSync(new URL("../.github/workflows/phase3-staging-cost-evidence.yml", import.meta.url), "utf8");
  const lifecycle = readFileSync(new URL("../.github/workflows/phase3-staging.yml", import.meta.url), "utf8");
  assert.doesNotMatch(cost, /secrets\.|staging:phase3:provider|RUN_LIVE_PHASE3_STAGING|SUPABASE_ACCESS_TOKEN|E2B_API_KEY/);
  assert.doesNotMatch(lifecycle, /measured_variable_cost_cad|PHASE3_STAGING_MEASURED_COST_CAD/);
  assert.match(lifecycle, /name: Await cost finalization[\s\S]*exit 1/);
  assert.match(cost, /run: node scripts\/finalize-phase3-cost.mjs/);
});

import assert from "node:assert/strict";
import test from "node:test";

import type { QualityEvidence, ReleaseAssessment } from "@atoms/quality";

import type { RunExecutionRecord } from "./domain.js";
import { DeterministicReleaseAssessor } from "./release-assessor.js";
import type {
  ReleaseAssessmentRepository,
  ReleaseAssessmentScope,
  ReleaseEvidenceInputs,
  UnresolvedAcceptanceScenario,
} from "./release-repository.js";

const RUN: RunExecutionRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  status: "RUNNING",
  prompt: "Build a customer portal",
  controlVersion: 4,
};

const EMMA_TASK_ID = "00000000-0000-4000-8000-000000000010";
const NOW = new Date("2026-09-14T00:05:00.000Z");

function emmaOutput(criteria: readonly { readonly key: string; readonly text: string }[]) {
  return {
    productName: "Portal",
    problemStatement: "Members need a workspace.",
    targetUsers: ["Members"],
    userStories: [
      {
        id: "US-001",
        role: "member",
        goal: "view a workspace",
        benefit: "self-serve",
        acceptanceCriteria: criteria,
      },
    ],
    nonGoals: [],
    assumptions: [],
  };
}

function baselineCommands(): ReleaseEvidenceInputs["baselineCommands"] {
  return (["lint", "typecheck", "test", "build"] as const).map((name, index) => ({
    id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
    name,
    startedAt: "2026-09-14T00:00:00.000Z",
    completedAt: "2026-09-14T00:00:10.000Z",
    exitCode: 0,
  }));
}

const FILES: ReleaseEvidenceInputs["files"] = [
  { path: "app/page.tsx", version: 1, content: "export default function Page() {}" },
];

class FakeRepository implements ReleaseAssessmentRepository {
  inputs: ReleaseEvidenceInputs = {
    files: FILES,
    acceptanceTask: {
      taskId: EMMA_TASK_ID,
      attempt: 0,
      output: emmaOutput([
        { key: "workspace.own_accessible", text: "Own workspace is accessible." },
        { key: "workspace.foreign_inaccessible", text: "Foreign workspace is inaccessible." },
      ]),
    },
    baselineCommands: baselineCommands(),
    acceptanceRun: null,
  };
  loadInputsError: Error | null = null;
  persisted: {
    readonly scope: ReleaseAssessmentScope;
    readonly assessment: ReleaseAssessment;
    readonly evidence: readonly QualityEvidence[];
    readonly unresolvedScenarios: readonly UnresolvedAcceptanceScenario[];
  }[] = [];
  failures: { readonly scope: ReleaseAssessmentScope }[] = [];

  async loadEvidenceInputs(): Promise<ReleaseEvidenceInputs> {
    if (this.loadInputsError !== null) throw this.loadInputsError;
    return this.inputs;
  }

  async persistAssessment(
    _assessmentId: string,
    scope: ReleaseAssessmentScope,
    assessment: ReleaseAssessment,
    evidence: readonly QualityEvidence[],
    _now: Date,
    unresolvedScenarios: readonly UnresolvedAcceptanceScenario[],
  ): Promise<void> {
    this.persisted.push({ scope, assessment, evidence, unresolvedScenarios });
  }

  async persistEvaluatorFailure(
    _assessmentId: string,
    scope: ReleaseAssessmentScope,
  ): Promise<void> {
    this.failures.push({ scope });
  }
}

test("with no acceptance run recorded, a fully passing baseline still stays BLOCKED on missing criterion evidence", async () => {
  const repository = new FakeRepository();
  const assessor = new DeterministicReleaseAssessor({ repository, now: () => NOW });

  await assessor.assess({ run: RUN, attempt: 2 });

  assert.equal(repository.failures.length, 0);
  assert.equal(repository.persisted.length, 1);
  const { assessment, evidence } = repository.persisted[0]!;
  assert.equal(assessment.status, "BLOCKED");
  assert.ok(
    assessment.issues.some((issue) => issue.code === "MISSING_CRITERION_EVIDENCE"),
    JSON.stringify(assessment.issues),
  );
  // The four baseline checks are still real, submitted evidence -- only
  // acceptance coverage is missing, because no acceptance step was recorded.
  assert.equal(evidence.filter((item) => item.kind !== "ACCEPTANCE").length, 4);
  assert.equal(evidence.some((item) => item.kind === "ACCEPTANCE"), false);
});

// G3 (docs/adr/production-execution-gate.md): the acceptance step exists and
// its stdout is read, but only scenarios the operator has explicitly mapped
// to a criterion semantic key in criterionKeysByScenario, and that this run's
// Emma output actually produced that key for, ever become ACCEPTANCE evidence.
test("G3: an acceptance run mapped to the run's only criterion clears MISSING_CRITERION_EVIDENCE", async () => {
  const repository = new FakeRepository();
  repository.inputs = {
    ...repository.inputs,
    acceptanceTask: {
      taskId: EMMA_TASK_ID, attempt: 0,
      output: emmaOutput([{ key: "workspace.own_accessible", text: "Own workspace is accessible." }]),
    },
    acceptanceRun: {
      id: "00000000-0000-4000-8000-000000000200",
      completedAt: "2026-09-14T00:00:20.000Z",
      stdout: JSON.stringify({ ok: true, results: [{ scenario: "home-loads", status: "PASSED", durationMs: 120 }] }),
    },
  };
  const assessor = new DeterministicReleaseAssessor({
    repository, now: () => NOW,
    criterionKeysByScenario: { "home-loads": ["workspace.own_accessible"] },
  });

  await assessor.assess({ run: RUN, attempt: 2 });

  const { assessment, evidence, unresolvedScenarios } = repository.persisted[0]!;
  // Still BLOCKED: the standard policy also requires REGRESSION/E2E/ACCESSIBILITY/
  // PERFORMANCE/SECURITY checks, which nothing in this repository submits -- that
  // gap is unrelated to G3. What G3 closes is specifically the criterion trace.
  assert.ok(
    assessment.issues.every((issue) => issue.code !== "MISSING_CRITERION_EVIDENCE"),
    JSON.stringify(assessment.issues),
  );
  const trace = assessment.traceToAcceptance.find((item) => item.criterionId === "US-001:1");
  assert.equal(trace?.status, "PASSED");
  assert.equal(evidence.filter((item) => item.kind === "ACCEPTANCE").length, 1);
  assert.deepEqual(unresolvedScenarios, []);
});

test("G3: a scenario mapped to a key this run's Emma output never produced is reported as unresolved, not silently blank", async () => {
  const repository = new FakeRepository();
  repository.inputs = {
    ...repository.inputs,
    acceptanceTask: {
      taskId: EMMA_TASK_ID, attempt: 0,
      output: emmaOutput([{ key: "workspace.own_accessible", text: "Own workspace is accessible." }]),
    },
    acceptanceRun: {
      id: "00000000-0000-4000-8000-000000000200",
      completedAt: "2026-09-14T00:00:20.000Z",
      stdout: JSON.stringify({ ok: true, results: [{ scenario: "home-loads", status: "PASSED", durationMs: 120 }] }),
    },
  };
  const assessor = new DeterministicReleaseAssessor({
    repository, now: () => NOW,
    criterionKeysByScenario: { "home-loads": ["workspace.never_produced"] },
  });

  await assessor.assess({ run: RUN, attempt: 2 });

  const { evidence, unresolvedScenarios } = repository.persisted[0]!;
  assert.equal(evidence.some((item) => item.kind === "ACCEPTANCE"), false);
  assert.deepEqual(unresolvedScenarios, [
    { scenario: "home-loads", missingKeys: ["workspace.never_produced"] },
  ]);
});

test("G3: a scenario the operator has not mapped to any criterion produces no evidence and stays BLOCKED", async () => {
  const repository = new FakeRepository();
  repository.inputs = {
    ...repository.inputs,
    acceptanceRun: {
      id: "00000000-0000-4000-8000-000000000200",
      completedAt: "2026-09-14T00:00:20.000Z",
      stdout: JSON.stringify({ ok: true, results: [{ scenario: "home-loads", status: "PASSED", durationMs: 120 }] }),
    },
  };
  // No criterionKeysByScenario supplied at all -- the default is an empty map.
  const assessor = new DeterministicReleaseAssessor({ repository, now: () => NOW });

  await assessor.assess({ run: RUN, attempt: 2 });

  const { assessment, evidence } = repository.persisted[0]!;
  assert.equal(assessment.status, "BLOCKED");
  assert.equal(evidence.some((item) => item.kind === "ACCEPTANCE"), false);
});

test("G3: malformed acceptance stdout is treated as no evidence, not an evaluator failure", async () => {
  const repository = new FakeRepository();
  repository.inputs = {
    ...repository.inputs,
    acceptanceRun: {
      id: "00000000-0000-4000-8000-000000000200",
      completedAt: "2026-09-14T00:00:20.000Z",
      stdout: "the sandbox exec crashed before it could report anything: contains sensitive detail",
    },
  };
  const assessor = new DeterministicReleaseAssessor({
    repository, now: () => NOW,
    criterionKeysByScenario: { "home-loads": ["workspace.own_accessible"] },
  });

  await assessor.assess({ run: RUN, attempt: 2 });

  assert.equal(repository.failures.length, 0);
  const { assessment, evidence } = repository.persisted[0]!;
  assert.equal(assessment.status, "BLOCKED");
  assert.equal(evidence.some((item) => item.kind === "ACCEPTANCE"), false);
  assert.ok(!JSON.stringify(repository.persisted).includes("sensitive detail"));
});

test("evidence bound to a superseded Emma attempt is rejected even though the current attempt's snapshot is used", async () => {
  const repository = new FakeRepository();
  // Simulate Emma having been retried: the trusted read now reports attempt 1.
  repository.inputs = {
    ...repository.inputs,
    acceptanceTask: { ...repository.inputs.acceptanceTask!, attempt: 1 },
  };
  const assessor = new DeterministicReleaseAssessor({ repository, now: () => NOW });

  await assessor.assess({ run: RUN, attempt: 2 });

  const { assessment } = repository.persisted[0]!;
  assert.equal(assessment.status, "BLOCKED");
  assert.equal(assessment.acceptanceTaskId, EMMA_TASK_ID);
  // No stale evidence was fabricated for the old attempt, so this is a
  // straightforward "nothing submitted yet" case, not a mismatch.
  assert.ok(assessment.issues.every((issue) => issue.code !== "ACCEPTANCE_TASK_MISMATCH"));
});

test("an evidence-gathering failure fails closed to a persisted BLOCKED record and never throws", async () => {
  const repository = new FakeRepository();
  repository.loadInputsError = new Error("db unavailable: contains sensitive detail");
  const assessor = new DeterministicReleaseAssessor({ repository, now: () => NOW });

  await assessor.assess({ run: RUN, attempt: 2 });

  assert.equal(repository.persisted.length, 0);
  assert.equal(repository.failures.length, 1);
  assert.equal(repository.failures[0]?.scope.runId, RUN.id);
});

test("assess() never rejects even if the repository itself cannot record the failure", async () => {
  const repository = new FakeRepository();
  repository.loadInputsError = new Error("boom");
  repository.persistEvaluatorFailure = () => {
    throw new Error("also boom");
  };
  const assessor = new DeterministicReleaseAssessor({ repository, now: () => NOW });

  await assert.doesNotReject(assessor.assess({ run: RUN, attempt: 2 }));
});

test("a run with no Emma task at all is reported MISSING_ACCEPTANCE, not silently READY", async () => {
  const repository = new FakeRepository();
  repository.inputs = { ...repository.inputs, acceptanceTask: null };
  const assessor = new DeterministicReleaseAssessor({ repository, now: () => NOW });

  await assessor.assess({ run: RUN, attempt: 1 });

  const { assessment } = repository.persisted[0]!;
  assert.equal(assessment.status, "BLOCKED");
  assert.ok(assessment.issues.some((issue) => issue.code === "MISSING_ACCEPTANCE"));
});

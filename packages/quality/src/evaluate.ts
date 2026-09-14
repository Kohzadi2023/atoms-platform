import {
  QualityEvaluationInputSchema,
  ReleaseAssessmentSchema,
  parseQualityInput,
  type QualityEvidence,
  type QualityIssue,
  type QualityScope,
  type ReleaseAssessment,
} from "./schema.js";

function sameScope(left: QualityScope, right: QualityScope): boolean {
  return left.workspaceId === right.workspaceId && left.projectId === right.projectId &&
    left.runId === right.runId && left.controlVersion === right.controlVersion &&
    left.attempt === right.attempt && left.snapshotSha256 === right.snapshotSha256;
}

/** Pure, deterministic observation. A READY report grants no execution or deployment authority. */
export function evaluateRelease(raw: unknown): ReleaseAssessment {
  const input = parseQualityInput(QualityEvaluationInputSchema, raw);
  const issues: QualityIssue[] = [];
  const accepted: QualityEvidence[] = [];
  const now = Date.parse(input.evaluatedAt);
  const counts = new Map<string, number>();
  for (const evidence of input.evidence) {
    counts.set(evidence.id, (counts.get(evidence.id) ?? 0) + 1);
  }
  const acceptance = input.acceptance;
  const acceptanceMatches = acceptance !== null && sameScope(input.scope, acceptance.scope);
  if (acceptance === null) issues.push({ code: "MISSING_ACCEPTANCE" });
  else if (!acceptanceMatches) issues.push({ code: "ACCEPTANCE_SCOPE_MISMATCH" });
  const criterionIds = new Set(acceptance?.criteria.map((criterion) => criterion.id) ?? []);

  // Inspect all submitted evidence. Invalid or failing evidence is never silently discarded
  // in favor of a newer passing record. Retried runs must be evaluated under their own scope.
  for (const evidence of input.evidence) {
    let usable = true;
    const reject = (code: QualityIssue["code"]) => {
      issues.push({ code, evidenceId: evidence.id });
      usable = false;
    };
    if ((counts.get(evidence.id) ?? 0) > 1) reject("DUPLICATE_EVIDENCE");
    if (!sameScope(input.scope, evidence.scope)) reject("EVIDENCE_SCOPE_MISMATCH");
    const age = now - Date.parse(evidence.completedAt);
    if (age < 0) reject("EVIDENCE_FROM_FUTURE");
    else if (age > input.policy.maxEvidenceAgeSeconds * 1_000) reject("EVIDENCE_TOO_OLD");
    if (evidence.kind === "ACCEPTANCE") {
      if (
        !acceptanceMatches ||
        evidence.acceptanceTaskId !== acceptance?.taskId ||
        evidence.acceptanceTaskAttempt !== acceptance?.taskAttempt
      ) {
        // Same code as a task-id mismatch: both mean this evidence does not attest the exact,
        // current attempt of the Emma task it claims to. A task retried in place keeps its id but
        // can carry different criteria text under the same positional criterion ids, so the id
        // alone is not "exact" enough on its own.
        reject("ACCEPTANCE_TASK_MISMATCH");
      }
      for (const criterionId of evidence.criterionIds) {
        if (!criterionIds.has(criterionId)) {
          issues.push({ code: "UNKNOWN_CRITERION", evidenceId: evidence.id, criterionId });
          usable = false;
        }
      }
    }
    if (evidence.status !== "PASSED") {
      issues.push({ code: "EVIDENCE_NOT_PASSED", evidenceId: evidence.id });
    }
    if (usable) accepted.push(evidence);
  }

  const coverage = (evidence: QualityEvidence[]) => ({
    status: evidence.length > 0 && evidence.every((item) => item.status === "PASSED")
      ? "PASSED" as const : "BLOCKED" as const,
    evidenceIds: evidence.map((item) => item.id).sort(),
  });
  const checks = [...input.policy.requiredChecks].sort().map((kind) => {
    const matching = accepted.filter((item) => item.kind === kind);
    if (matching.length === 0) issues.push({ code: "MISSING_CHECK", check: kind });
    return { kind, ...coverage(matching) };
  });
  const traceToAcceptance = (acceptance?.criteria ?? []).map((criterion) => {
    const matching = acceptanceMatches ? accepted.filter((item) =>
      item.kind === "ACCEPTANCE" && item.criterionIds.includes(criterion.id)) : [];
    if (matching.length === 0) {
      issues.push({ code: "MISSING_CRITERION_EVIDENCE", criterionId: criterion.id });
    }
    return { criterionId: criterion.id, ...coverage(matching) };
  }).sort((left, right) => left.criterionId < right.criterionId ? -1 : left.criterionId > right.criterionId ? 1 : 0);

  // Canonical ordering makes equivalent evidence sets produce the same report.
  const uniqueIssues = [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, issue]) => issue);
  return ReleaseAssessmentSchema.parse({
    schemaVersion: "quality.assessment.v1",
    mode: "OBSERVE_ONLY",
    scope: input.scope,
    evaluatedAt: input.evaluatedAt,
    policy: { ...input.policy, requiredChecks: [...input.policy.requiredChecks].sort() },
    status: uniqueIssues.length === 0 ? "READY" : "BLOCKED",
    acceptanceTaskId: acceptance?.taskId ?? null,
    checks,
    traceToAcceptance,
    issues: uniqueIssues,
  });
}

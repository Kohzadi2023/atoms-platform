import { STANDARD_RELEASE_POLICY, type QualityEvaluationInput, type QualityEvidence } from "./schema.js";

export const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
export const scope = {
  workspaceId: uuid(1), projectId: uuid(2), runId: uuid(3),
  controlVersion: 0, attempt: 1, snapshotSha256: "a".repeat(64),
};

export function fixture(): QualityEvaluationInput {
  const acceptance = {
    taskId: uuid(4), scope: { ...scope },
    criteria: [
      { id: "US-001:1", text: "A member can view their workspace." },
      { id: "US-001:2", text: "Foreign workspaces remain inaccessible." },
    ],
  };
  const checks: QualityEvidence[] = STANDARD_RELEASE_POLICY.requiredChecks.map((kind, index) => ({
    id: uuid(10 + index), sourceArtifactId: uuid(110 + index), scope: { ...scope }, kind,
    status: "PASSED", completedAt: "2026-09-14T00:00:00.000Z",
    acceptanceTaskId: null, criterionIds: [],
  }));
  const acceptanceEvidence: QualityEvidence[] = acceptance.criteria.map((criterion, index) => ({
    id: uuid(30 + index), sourceArtifactId: uuid(130 + index), scope: { ...scope }, kind: "ACCEPTANCE",
    status: "PASSED", completedAt: "2026-09-14T00:00:00.000Z",
    acceptanceTaskId: acceptance.taskId, criterionIds: [criterion.id],
  }));
  return {
    scope: { ...scope }, evaluatedAt: "2026-09-14T00:01:00.000Z",
    policy: { ...STANDARD_RELEASE_POLICY, requiredChecks: [...STANDARD_RELEASE_POLICY.requiredChecks] },
    acceptance, evidence: [...checks, ...acceptanceEvidence],
  };
}

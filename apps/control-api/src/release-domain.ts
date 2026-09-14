import { JsonValueSchema, type ReleaseAssessmentResponse } from "@atoms/contracts";

export interface ReleaseAssessmentRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly controlVersion: number;
  readonly attempt: number;
  readonly snapshotSha256: string;
  readonly status: "READY" | "BLOCKED";
  readonly acceptanceTaskId: string | null;
  readonly policy: unknown;
  readonly checks: unknown;
  readonly traceToAcceptance: unknown;
  readonly issues: unknown;
  readonly evaluatedAt: Date;
  readonly createdAt: Date;
}

export function toReleaseAssessmentResponse(
  record: ReleaseAssessmentRecord,
): ReleaseAssessmentResponse {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    runId: record.runId,
    controlVersion: record.controlVersion,
    attempt: record.attempt,
    snapshotSha256: record.snapshotSha256,
    status: record.status,
    mode: "OBSERVE_ONLY",
    acceptanceTaskId: record.acceptanceTaskId,
    policy: JsonValueSchema.parse(record.policy),
    checks: JsonValueSchema.parse(record.checks),
    traceToAcceptance: JsonValueSchema.parse(record.traceToAcceptance),
    issues: JsonValueSchema.parse(record.issues),
    evaluatedAt: record.evaluatedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

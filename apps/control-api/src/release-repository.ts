import { randomUUID } from "node:crypto";

import { JsonValueSchema, type WorkspaceRole } from "@atoms/contracts";
import { Prisma, type PrismaClient } from "@atoms/db";
import {
  STANDARD_RELEASE_POLICY,
  createAcceptanceSnapshot,
  evaluateRelease,
  evidenceFromValidationStep,
  fingerprintProjectSnapshot,
  type QualityEvidence,
  type QualityScope,
} from "@atoms/quality";

import type { ReleaseAssessmentRecord } from "./release-domain.js";

export type TriggerReleaseAssessmentResult =
  | { readonly kind: "ok"; readonly assessment: ReleaseAssessmentRecord }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "no_eligible_run" };

export interface ReleaseControlRepository {
  getProjectWorkspaceMembership(
    userId: string,
    projectId: string,
  ): Promise<{ readonly workspaceId: string; readonly role: WorkspaceRole } | null>;
  triggerReleaseAssessment(
    userId: string,
    projectId: string,
    now: Date,
  ): Promise<TriggerReleaseAssessmentResult>;
  getReleaseAssessment(
    userId: string,
    assessmentId: string,
  ): Promise<ReleaseAssessmentRecord | null>;
}

const SANDBOX_COMMAND_NAME_TO_STEP: Record<
  string,
  "install" | "prisma-validate" | "lint" | "typecheck" | "test" | "build" | "preview-start" | "preview-health"
> = {
  INSTALL: "install",
  PRISMA_VALIDATE: "prisma-validate",
  LINT: "lint",
  TYPECHECK: "typecheck",
  TEST: "test",
  BUILD: "build",
  PREVIEW_START: "preview-start",
  PREVIEW_HEALTH: "preview-health",
};

export class PrismaReleaseControlRepository implements ReleaseControlRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async getProjectWorkspaceMembership(
    userId: string,
    projectId: string,
  ): Promise<{ readonly workspaceId: string; readonly role: WorkspaceRole } | null> {
    const membership = await this.#prisma.membership.findFirst({
      where: {
        userId,
        workspace: { projects: { some: { id: projectId, archivedAt: null } } },
      },
      select: { workspaceId: true, role: true },
    });
    return membership === null
      ? null
      : { workspaceId: membership.workspaceId, role: membership.role };
  }

  async triggerReleaseAssessment(
    userId: string,
    projectId: string,
    now: Date,
  ): Promise<TriggerReleaseAssessmentResult> {
    const project = await this.#prisma.project.findFirst({
      where: {
        id: projectId,
        archivedAt: null,
        workspace: { memberships: { some: { userId } } },
      },
      select: { id: true, workspaceId: true },
    });
    if (project === null) return { kind: "project_not_found" };

    const run = await this.#prisma.agentRun.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, controlVersion: true },
    });
    if (run === null) return { kind: "no_eligible_run" };

    // Same worker-level "attempt" concept the QA README documents (a run's
    // own retry count); the control API does not track that separately, so
    // an on-demand trigger always assesses against attempt 1 of the current
    // controlVersion. This mirrors the fact that only one assessment can
    // exist per (runId, controlVersion, attempt) -- a later worker-driven
    // assessment for a genuinely different attempt is not overwritten by
    // this one, and vice versa.
    const attempt = 1;

    const [files, acceptanceTask, sandboxCommands] = await Promise.all([
      this.#prisma.projectFile.findMany({
        where: { projectId: project.id },
        orderBy: [{ filePath: "asc" }, { version: "desc" }],
        distinct: ["filePath"],
        select: { filePath: true, version: true, content: true },
      }),
      this.#prisma.agentTask.findFirst({
        where: { runId: run.id, agentName: "Emma" },
        orderBy: { ordinal: "asc" },
        select: { id: true, attempt: true, output: true, status: true },
      }),
      this.#prisma.sandboxCommand.findMany({
        where: { sandboxSession: { runId: run.id } },
        orderBy: { ordinal: "asc" },
        select: { id: true, name: true, startedAt: true, completedAt: true, exitCode: true },
      }),
    ]);

    const assessmentId = randomUUID();
    const scope = {
      workspaceId: project.workspaceId,
      projectId: project.id,
      runId: run.id,
      controlVersion: run.controlVersion,
      attempt,
    };

    try {
      const snapshotSha256 = fingerprintProjectSnapshot(
        files.map((file) => ({ path: file.filePath, version: file.version, content: file.content })),
      );
      const qualityScope: QualityScope = { ...scope, snapshotSha256 };

      const acceptance =
        acceptanceTask === null || acceptanceTask.status !== "COMPLETED" || acceptanceTask.output === null
          ? null
          : createAcceptanceSnapshot({
              scope: qualityScope,
              taskId: acceptanceTask.id,
              taskAttempt: acceptanceTask.attempt,
              output: JsonValueSchema.parse(acceptanceTask.output),
            });

      const evidence: QualityEvidence[] = [];
      for (const command of sandboxCommands) {
        const step = SANDBOX_COMMAND_NAME_TO_STEP[command.name];
        if (step === undefined) continue;
        const item = evidenceFromValidationStep({
          scope: qualityScope,
          commandId: command.id,
          step: {
            name: step,
            startedAt: command.startedAt.toISOString(),
            completedAt: command.completedAt.toISOString(),
            result: { exitCode: command.exitCode },
          },
        });
        if (item !== null) evidence.push(item);
      }

      const assessment = evaluateRelease({
        scope: qualityScope,
        evaluatedAt: now.toISOString(),
        policy: { ...STANDARD_RELEASE_POLICY, requiredChecks: [...STANDARD_RELEASE_POLICY.requiredChecks] },
        acceptance,
        evidence,
      });

      return {
        kind: "ok",
        assessment: await this.#persist(assessmentId, scope, {
          status: assessment.status,
          acceptanceTaskId: assessment.acceptanceTaskId,
          policy: assessment.policy,
          checks: assessment.checks,
          traceToAcceptance: assessment.traceToAcceptance,
          issues: assessment.issues,
          snapshotSha256,
          evaluatedAt: now,
        }),
      };
    } catch {
      // Fail closed: never report READY, never silently skip persisting.
      return {
        kind: "ok",
        assessment: await this.#persist(assessmentId, scope, {
          status: "BLOCKED",
          acceptanceTaskId: null,
          policy: {},
          checks: [],
          traceToAcceptance: [],
          issues: [{ code: "EVALUATOR_FAILURE" }],
          snapshotSha256: "0".repeat(64),
          evaluatedAt: now,
        }),
      };
    }
  }

  async getReleaseAssessment(
    userId: string,
    assessmentId: string,
  ): Promise<ReleaseAssessmentRecord | null> {
    const assessment = await this.#prisma.releaseAssessment.findFirst({
      where: {
        id: assessmentId,
        project: { workspace: { memberships: { some: { userId } } } },
      },
    });
    return assessment === null ? null : toRecord(assessment);
  }

  async #persist(
    assessmentId: string,
    scope: { readonly workspaceId: string; readonly projectId: string; readonly runId: string; readonly controlVersion: number; readonly attempt: number },
    data: {
      readonly status: "READY" | "BLOCKED";
      readonly acceptanceTaskId: string | null;
      readonly policy: unknown;
      readonly checks: unknown;
      readonly traceToAcceptance: unknown;
      readonly issues: unknown;
      readonly snapshotSha256: string;
      readonly evaluatedAt: Date;
    },
  ): Promise<ReleaseAssessmentRecord> {
    const record = await this.#prisma.releaseAssessment.upsert({
      where: {
        runId_controlVersion_attempt: {
          runId: scope.runId,
          controlVersion: scope.controlVersion,
          attempt: scope.attempt,
        },
      },
      update: {
        id: assessmentId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        snapshotSha256: data.snapshotSha256,
        status: data.status,
        acceptanceTaskId: data.acceptanceTaskId,
        policy: toPrismaJson(data.policy),
        checks: toPrismaJson(data.checks),
        traceToAcceptance: toPrismaJson(data.traceToAcceptance),
        issues: toPrismaJson(data.issues),
        evaluatedAt: data.evaluatedAt,
      },
      create: {
        id: assessmentId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        runId: scope.runId,
        controlVersion: scope.controlVersion,
        attempt: scope.attempt,
        snapshotSha256: data.snapshotSha256,
        status: data.status,
        acceptanceTaskId: data.acceptanceTaskId,
        policy: toPrismaJson(data.policy),
        checks: toPrismaJson(data.checks),
        traceToAcceptance: toPrismaJson(data.traceToAcceptance),
        issues: toPrismaJson(data.issues),
        evaluatedAt: data.evaluatedAt,
      },
    });
    return toRecord(record);
  }
}

function toRecord(record: {
  id: string;
  workspaceId: string;
  projectId: string;
  runId: string;
  controlVersion: number;
  attempt: number;
  snapshotSha256: string;
  status: "READY" | "BLOCKED";
  acceptanceTaskId: string | null;
  policy: unknown;
  checks: unknown;
  traceToAcceptance: unknown;
  issues: unknown;
  evaluatedAt: Date;
  createdAt: Date;
}): ReleaseAssessmentRecord {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    runId: record.runId,
    controlVersion: record.controlVersion,
    attempt: record.attempt,
    snapshotSha256: record.snapshotSha256,
    status: record.status,
    acceptanceTaskId: record.acceptanceTaskId,
    policy: record.policy,
    checks: record.checks,
    traceToAcceptance: record.traceToAcceptance,
    issues: record.issues,
    evaluatedAt: record.evaluatedAt,
    createdAt: record.createdAt,
  };
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

import type { JsonValue, RunEventType } from "@atoms/contracts";
import { JsonValueSchema, validateRunEventPayload } from "@atoms/contracts";
import { Prisma, type PrismaClient } from "@atoms/db";
import type { ReleaseAssessment as QualityReleaseAssessment, QualityEvidence } from "@atoms/quality";

/**
 * Everything the assessor needs to build QualityEvidence / an AcceptanceSnapshot,
 * read straight from durable, agent-authored rows. Nothing here is accepted from
 * request bodies or model output at call time -- in particular `attempt` on the
 * acceptance task is the AgentTask row's own counter, read fresh from the
 * database, never passed in by a caller. Matching metadata alone does not prove
 * a check actually ran; this repository only prevents the *scope* of that trust
 * problem from getting worse by ensuring the identifiers themselves are genuine.
 */
export interface AcceptanceTaskSnapshot {
  readonly taskId: string;
  readonly attempt: number;
  readonly output: JsonValue;
}

export interface BaselineCommandRecord {
  readonly id: string;
  readonly name:
    | "install"
    | "prisma-validate"
    | "lint"
    | "typecheck"
    | "test"
    | "build"
    | "preview-start"
    | "preview-health";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly exitCode: number;
}

export interface ReleaseEvidenceInputs {
  readonly files: ReadonlyArray<{ readonly path: string; readonly version: number; readonly content: string }>;
  readonly acceptanceTask: AcceptanceTaskSnapshot | null;
  readonly baselineCommands: readonly BaselineCommandRecord[];
}

export interface ReleaseAssessmentScope {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly controlVersion: number;
  readonly attempt: number;
}

export interface ReleaseAssessmentRepository {
  loadEvidenceInputs(runId: string): Promise<ReleaseEvidenceInputs>;
  persistAssessment(
    assessmentId: string,
    scope: ReleaseAssessmentScope,
    assessment: QualityReleaseAssessment,
    evidence: readonly QualityEvidence[],
    now: Date,
  ): Promise<void>;
  persistEvaluatorFailure(
    assessmentId: string,
    scope: ReleaseAssessmentScope,
    now: Date,
  ): Promise<void>;
}

const SANDBOX_COMMAND_NAME_TO_STEP: Record<string, BaselineCommandRecord["name"]> = {
  INSTALL: "install",
  PRISMA_VALIDATE: "prisma-validate",
  LINT: "lint",
  TYPECHECK: "typecheck",
  TEST: "test",
  BUILD: "build",
  PREVIEW_START: "preview-start",
  PREVIEW_HEALTH: "preview-health",
};

export class PrismaReleaseAssessmentRepository implements ReleaseAssessmentRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async loadEvidenceInputs(runId: string): Promise<ReleaseEvidenceInputs> {
    const run = await this.#prisma.agentRun.findUniqueOrThrow({
      where: { id: runId },
      select: { projectId: true },
    });
    const [files, acceptanceTask, sandboxCommands] = await Promise.all([
      this.#prisma.projectFile.findMany({
        where: { projectId: run.projectId },
        orderBy: [{ filePath: "asc" }, { version: "desc" }],
        distinct: ["filePath"],
        select: { filePath: true, version: true, content: true },
      }),
      // Trusted read: taskId, attempt, and output all come from this row as it
      // exists right now. Never accept these fields from a caller.
      this.#prisma.agentTask.findFirst({
        where: { runId, agentName: "Emma" },
        orderBy: { ordinal: "asc" },
        select: { id: true, attempt: true, output: true, status: true },
      }),
      this.#prisma.sandboxCommand.findMany({
        where: { sandboxSession: { runId } },
        orderBy: { ordinal: "asc" },
        select: {
          id: true,
          name: true,
          startedAt: true,
          completedAt: true,
          exitCode: true,
        },
      }),
    ]);

    return {
      files: files.map((file) => ({
        path: file.filePath,
        version: file.version,
        content: file.content,
      })),
      acceptanceTask:
        acceptanceTask === null ||
        acceptanceTask.status !== "COMPLETED" ||
        acceptanceTask.output === null
          ? null
          : {
              taskId: acceptanceTask.id,
              attempt: acceptanceTask.attempt,
              output: JsonValueSchema.parse(acceptanceTask.output),
            },
      baselineCommands: sandboxCommands.map((command) => ({
        id: command.id,
        name: SANDBOX_COMMAND_NAME_TO_STEP[command.name] ?? "install",
        startedAt: command.startedAt.toISOString(),
        completedAt: command.completedAt.toISOString(),
        exitCode: command.exitCode,
      })),
    };
  }

  async persistAssessment(
    assessmentId: string,
    scope: ReleaseAssessmentScope,
    assessment: QualityReleaseAssessment,
    evidence: readonly QualityEvidence[],
    now: Date,
  ): Promise<void> {
    await this.#prisma.$transaction(async (transaction) => {
      await transaction.releaseAssessment.upsert({
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
          snapshotSha256: assessment.scope.snapshotSha256,
          status: assessment.status,
          acceptanceTaskId: assessment.acceptanceTaskId,
          policy: toPrismaJson(assessment.policy),
          checks: toPrismaJson(assessment.checks),
          traceToAcceptance: toPrismaJson(assessment.traceToAcceptance),
          issues: toPrismaJson(assessment.issues),
          evaluatedAt: new Date(assessment.evaluatedAt),
        },
        create: {
          id: assessmentId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          runId: scope.runId,
          controlVersion: scope.controlVersion,
          attempt: scope.attempt,
          snapshotSha256: assessment.scope.snapshotSha256,
          status: assessment.status,
          acceptanceTaskId: assessment.acceptanceTaskId,
          policy: toPrismaJson(assessment.policy),
          checks: toPrismaJson(assessment.checks),
          traceToAcceptance: toPrismaJson(assessment.traceToAcceptance),
          issues: toPrismaJson(assessment.issues),
          evaluatedAt: new Date(assessment.evaluatedAt),
        },
      });
      await transaction.releaseEvidence.deleteMany({ where: { assessmentId } });
      if (evidence.length > 0) {
        await transaction.releaseEvidence.createMany({
          data: evidence.map((item) => ({
            id: item.id,
            assessmentId,
            sourceArtifactId: item.sourceArtifactId,
            kind: item.kind,
            status: item.status,
            completedAt: new Date(item.completedAt),
            acceptanceTaskId: item.acceptanceTaskId,
            acceptanceTaskAttempt: item.acceptanceTaskAttempt,
            criterionIds: toPrismaJson(item.criterionIds),
          })),
        });
      }
      await appendReleaseEvent(
        transaction,
        scope.runId,
        "release.assessment_started",
        { version: "v1", assessmentId, attempt: scope.attempt },
      );
      await appendReleaseEvent(
        transaction,
        scope.runId,
        assessment.status === "READY" ? "release.ready" : "release.blocked",
        assessment.status === "READY"
          ? {
              version: "v1",
              assessmentId,
              status: "READY",
              checkCount: assessment.checks.length,
              criterionCount: assessment.traceToAcceptance.length,
            }
          : {
              version: "v1",
              assessmentId,
              status: "BLOCKED",
              issueCount: Math.max(assessment.issues.length, 1),
            },
      );
    });
    void now;
  }

  /**
   * Fail closed: an evaluator or evidence-gathering exception must never be
   * silently dropped and must never be reported as READY. This records a
   * BLOCKED assessment with a single redacted diagnostic code -- no raw error
   * message, stack trace, or partial evidence is persisted, since the failure
   * itself may have happened before inputs could be validated as safe to store.
   */
  async persistEvaluatorFailure(
    assessmentId: string,
    scope: ReleaseAssessmentScope,
    now: Date,
  ): Promise<void> {
    await this.#prisma.$transaction(async (transaction) => {
      await transaction.releaseAssessment.upsert({
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
          snapshotSha256: "0".repeat(64),
          status: "BLOCKED",
          acceptanceTaskId: null,
          policy: toPrismaJson({}),
          checks: toPrismaJson([]),
          traceToAcceptance: toPrismaJson([]),
          issues: toPrismaJson([{ code: "EVALUATOR_FAILURE" }]),
          evaluatedAt: now,
        },
        create: {
          id: assessmentId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          runId: scope.runId,
          controlVersion: scope.controlVersion,
          attempt: scope.attempt,
          snapshotSha256: "0".repeat(64),
          status: "BLOCKED",
          acceptanceTaskId: null,
          policy: toPrismaJson({}),
          checks: toPrismaJson([]),
          traceToAcceptance: toPrismaJson([]),
          issues: toPrismaJson([{ code: "EVALUATOR_FAILURE" }]),
          evaluatedAt: now,
        },
      });
      await transaction.releaseEvidence.deleteMany({ where: { assessmentId } });
      await appendReleaseEvent(
        transaction,
        scope.runId,
        "release.assessment_started",
        { version: "v1", assessmentId, attempt: scope.attempt },
      );
      await appendReleaseEvent(transaction, scope.runId, "release.blocked", {
        version: "v1",
        assessmentId,
        status: "BLOCKED",
        issueCount: 1,
      });
    });
  }
}

async function appendReleaseEvent(
  transaction: Prisma.TransactionClient,
  runId: string,
  eventType: RunEventType,
  payload: JsonValue,
): Promise<void> {
  const normalizedPayload = JsonValueSchema.parse(
    validateRunEventPayload(eventType, payload),
  );
  const run = await transaction.agentRun.update({
    where: { id: runId },
    data: { eventSequence: { increment: 1 } },
    select: { eventSequence: true },
  });
  await transaction.runEvent.create({
    data: {
      runId,
      sequence: run.eventSequence,
      eventType,
      payload: toPrismaJson(normalizedPayload),
    },
  });
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

import { randomUUID } from "node:crypto";

import {
  STANDARD_RELEASE_POLICY,
  createAcceptanceSnapshot,
  evaluateRelease,
  evidenceFromAcceptanceRun,
  evidenceFromValidationStep,
  fingerprintProjectSnapshot,
  resolveCriterionIdsByScenario,
  type QualityEvidence,
  type QualityScope,
} from "@atoms/quality";

import type { RunExecutionRecord } from "./domain.js";
import type { ReleaseAssessmentRepository } from "./release-repository.js";

export interface AssessReleaseInput {
  readonly run: RunExecutionRecord;
  /** The worker-level retry attempt (RunAttempt.attempt), the same value the
   *  RunValidator already receives -- not a task attempt. */
  readonly attempt: number;
}

export interface ReleaseAssessorOptions {
  readonly repository: ReleaseAssessmentRepository;
  /**
   * G3: which of Emma's acceptance-criterion semantic keys each
   * acceptance-scenario name is evidence for
   * (apps/orchestrator-worker/src/acceptance-manifest.ts). Static across the
   * assessor's lifetime -- resolved to this run's actual positional
   * criterion ids inside assess(), since those ids are regenerated fresh
   * every run. Defaults to an empty map, meaning no ACCEPTANCE evidence is
   * ever built, the same state as before this option existed.
   */
  readonly criterionKeysByScenario?: Readonly<Record<string, readonly string[]>>;
  readonly now?: () => Date;
}

/**
 * Optional, observe-only step run after validation and before completeRun.
 * Mirrors how RunValidator is an interface with Phase2RunValidator as its
 * concrete implementation, so RunProcessor depends on this shape rather than
 * on the Prisma-backed implementation directly.
 */
export interface ReleaseAssessor {
  assess(input: AssessReleaseInput): Promise<void>;
}

/**
 * Display name "Quinn" (human-facing label only, e.g. in docs/roadmap
 * conversations -- no code surface renders it today, unlike the persona
 * agents in packages/agents/src/manifests.ts). The internal identifier
 * stays "QA & Release" / DeterministicReleaseAssessor everywhere in code.
 *
 * Never part of the LangGraph state graph (no node, no back-edge) and never
 * affects run completion: assess() only throws if the repository's own
 * writes fail after every reasonable evaluator error has already been
 * downgraded to a persisted BLOCKED assessment -- and even that is swallowed
 * below, so the processor treats a QA failure exactly like an absent
 * assessor: it does not stop the run from completing.
 */
export class DeterministicReleaseAssessor implements ReleaseAssessor {
  readonly #repository: ReleaseAssessmentRepository;
  readonly #criterionKeysByScenario: Readonly<Record<string, readonly string[]>>;
  readonly #now: () => Date;

  constructor(options: ReleaseAssessorOptions) {
    this.#repository = options.repository;
    this.#criterionKeysByScenario = options.criterionKeysByScenario ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  async assess(input: AssessReleaseInput): Promise<void> {
    const assessmentId = randomUUID();
    const scope = {
      workspaceId: input.run.workspaceId,
      projectId: input.run.projectId,
      runId: input.run.id,
      controlVersion: input.run.controlVersion,
      attempt: input.attempt,
    };
    const now = this.#now();

    try {
      const { files, acceptanceTask, baselineCommands, acceptanceRun } =
        await this.#repository.loadEvidenceInputs(input.run.id, input.attempt);
      const snapshotSha256 = fingerprintProjectSnapshot(files);
      const qualityScope: QualityScope = { ...scope, snapshotSha256 };

      const acceptance =
        acceptanceTask === null
          ? null
          : createAcceptanceSnapshot({
              scope: qualityScope,
              taskId: acceptanceTask.taskId,
              // Read fresh from the AgentTask row inside loadEvidenceInputs --
              // never accepted from a caller of assess().
              taskAttempt: acceptanceTask.attempt,
              output: acceptanceTask.output,
            });

      const evidence: QualityEvidence[] = [];
      for (const command of baselineCommands) {
        const item = evidenceFromValidationStep({
          scope: qualityScope,
          commandId: command.id,
          step: {
            name: command.name,
            startedAt: command.startedAt,
            completedAt: command.completedAt,
            result: { exitCode: command.exitCode },
          },
        });
        if (item !== null) evidence.push(item);
      }
      // G3: only produces evidence for scenarios this project type's manifest
      // maps to specific criterion semantic keys (see acceptance-manifest.ts)
      // AND that this run's Emma output actually produced a criterion for --
      // resolveCriterionIdsByScenario turns the static key map into this
      // run's actual positional ids since those are regenerated every run.
      // A key the manifest expects but this run never produced is reported
      // back as unresolvedScenarios rather than silently behaving like an
      // unmapped scenario.
      let unresolvedScenarios: readonly { readonly scenario: string; readonly missingKeys: readonly string[] }[] = [];
      if (acceptance !== null && acceptanceRun !== null) {
        const resolution = resolveCriterionIdsByScenario(acceptance, this.#criterionKeysByScenario);
        unresolvedScenarios = resolution.unresolvedScenarios;
        evidence.push(...evidenceFromAcceptanceRun({
          scope: qualityScope,
          sourceArtifactId: acceptanceRun.id,
          acceptanceTaskId: acceptance.taskId,
          acceptanceTaskAttempt: acceptance.taskAttempt,
          completedAt: acceptanceRun.completedAt,
          criterionIdsByScenario: resolution.criterionIdsByScenario,
          stdout: acceptanceRun.stdout,
        }));
      }

      const assessment = evaluateRelease({
        scope: qualityScope,
        evaluatedAt: now.toISOString(),
        policy: {
          ...STANDARD_RELEASE_POLICY,
          requiredChecks: [...STANDARD_RELEASE_POLICY.requiredChecks],
        },
        acceptance,
        evidence,
      });

      await this.#repository.persistAssessment(
        assessmentId,
        scope,
        assessment,
        evidence,
        now,
        unresolvedScenarios,
      );
    } catch {
      // Deliberately swallow the error here rather than rethrow: this step is
      // observe-only and must never fail or block run completion. The only
      // safe action on any failure -- a malformed record, a transient DB
      // read error, an evaluator throw -- is to fail closed to a persisted
      // BLOCKED assessment with a redacted diagnostic, never to infer READY
      // or to leave no record at all.
      try {
        await this.#repository.persistEvaluatorFailure(assessmentId, scope, now);
      } catch {
        // Swallow here too: persistEvaluatorFailure can reject asynchronously
        // or throw synchronously, and neither may ever escape assess().
      }
    }
  }
}

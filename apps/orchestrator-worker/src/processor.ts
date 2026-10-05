import type { AgentRuntime } from "@atoms/agents";
import { RunJobSchema, type JsonValue, type RunJob } from "@atoms/contracts";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

import type { RunExecutionRecord, WorkerRepository } from "./domain.js";
import {
  findRunStoppedError,
  isRetryableError,
  toWorkerError,
} from "./errors.js";
import { buildRunGraph, parseUpstreamOutputs } from "./graph.js";
import { describeMissingRoutes, findMissingRoutes, ROUTE_COVERAGE_STEP } from "./route-coverage.js";
import {
  findValidationFailure,
  isRepairableValidationStep,
  type RunRepairer,
} from "./repair.js";
import type { RunValidationLease, RunValidator } from "./validation.js";
import type { RunAttachmentLoader } from "./attachment-loader.js";
import type { ReleaseAssessor } from "./release-assessor.js";

export interface RunAttempt {
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type ProcessRunResult =
  | { readonly outcome: "completed" }
  | { readonly outcome: "failed" }
  | { readonly outcome: "stopped"; readonly status: string }
  | { readonly outcome: "skipped"; readonly reason: "missing" | "stale" };

export interface RunProcessorOptions {
  readonly repository: WorkerRepository;
  readonly agents: AgentRuntime;
  readonly checkpointer?: BaseCheckpointSaver;
  readonly validator?: RunValidator;
  /** Optional, observe-only QA & Release step. Runs after the validator and
   *  before completeRun; never part of the LangGraph state graph and never
   *  blocking (see ReleaseAssessor). Omitting it is a no-op, matching how
   *  omitting `validator` already behaves. */
  readonly assessor?: ReleaseAssessor;
  readonly attachmentLoader?: RunAttachmentLoader;
  /** When validation fails on a repairable step, asks the model to fix the code and validates again. */
  readonly repairer?: RunRepairer;
  /** How many automatic repairs one run may spend (default 0: none). */
  readonly maxRepairAttempts?: number;
  readonly now?: () => Date;
}

// A repaired validation is recorded as its own sandbox session, and sandbox
// sessions are unique per (run, attempt). Offsetting by repair keeps the
// worker's real attempt number readable while never colliding with it.
const REPAIR_ATTEMPT_STRIDE = 100;

export class RunProcessor {
  readonly #repository: WorkerRepository;
  readonly #now: () => Date;
  readonly #graph: ReturnType<typeof buildRunGraph>;
  readonly #validator: RunValidator | undefined;
  readonly #assessor: ReleaseAssessor | undefined;
  readonly #repairer: RunRepairer | undefined;
  readonly #maxRepairAttempts: number;

  constructor(options: RunProcessorOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
    this.#graph = buildRunGraph(options);
    this.#validator = options.validator;
    this.#assessor = options.assessor;
    this.#repairer = options.repairer;
    this.#maxRepairAttempts = options.maxRepairAttempts ?? 0;
  }

  /**
   * Bob's planned routes against the files Alex actually wrote. A missing route
   * (a login handler that was never generated, say) ships a preview that opens
   * on a 404, so it gets one repair before any sandbox is paid for. Advisory
   * only: a failed or empty repair never fails the run, validation still runs.
   * Returns how many repairs this spent (0 or 1).
   */
  async #repairMissingRoutes(
    run: RunExecutionRecord,
    outputs: Readonly<Record<string, JsonValue>>,
  ): Promise<number> {
    if (this.#repairer === undefined || this.#maxRepairAttempts < 1) return 0;
    try {
      const upstream = parseUpstreamOutputs(outputs);
      if (upstream.Bob === undefined) return 0;
      const files = await this.#repository.listProjectFiles(run.projectId);
      // The preview opens on "/", so the app's entry route is required whether or not
      // Bob planned it (a live run planned only /login and /staff and shipped a 404).
      const missing = findMissingRoutes(
        [{ method: "GET", path: "/" }, ...upstream.Bob.routes],
        files.map((file) => file.path),
      );
      if (missing.length === 0) return 0;
      const repaired = await this.#repairer.repair({
        run,
        failure: {
          step: ROUTE_COVERAGE_STEP,
          exitCode: 1,
          output: describeMissingRoutes(missing),
        },
        upstreamOutputs: upstream,
        repairAttempt: 1,
      });
      return repaired ? 1 : 0;
    } catch (error) {
      if (findRunStoppedError(error) !== null) throw error;
      console.error(
        `Route-coverage repair failed for run ${run.id}:`,
        error instanceof Error ? error.message : error,
      );
      return 0;
    }
  }

  async process(
    untrustedJob: RunJob,
    attempt: RunAttempt,
  ): Promise<ProcessRunResult> {
    const job = RunJobSchema.parse(untrustedJob);
    if (
      !Number.isInteger(attempt.attempt) ||
      !Number.isInteger(attempt.maxAttempts) ||
      attempt.attempt < 1 ||
      attempt.maxAttempts < attempt.attempt
    ) {
      throw new RangeError("Invalid worker attempt metadata");
    }

    const claim = await this.#repository.claimRun(job, this.#now());
    if (claim.kind === "missing") {
      return { outcome: "skipped", reason: "missing" };
    }
    if (claim.kind === "stale") {
      return { outcome: "skipped", reason: "stale" };
    }

    let validationLease: RunValidationLease | void = undefined;
    try {
      const finalState = await this.#graph.invoke(
        {
          runId: claim.run.id,
          workspaceId: claim.run.workspaceId,
          projectId: claim.run.projectId,
          prompt: claim.run.prompt,
          command: job.command,
          approvalScope: job.approvalScope,
          controlVersion: claim.run.controlVersion,
          approvalBypassConsumed: false,
          outputs: {},
        },
        {
          configurable: {
            thread_id: claim.run.id,
            checkpoint_ns: `job:${job.command}:${String(job.controlVersion)}`,
          },
        },
      );

      // The sandbox attempt that actually passed: a repaired validation is recorded
      // under attempt + repairs * stride, and the release assessor must read the
      // evidence of that session, not of the failed first one.
      let validatedAttempt = attempt.attempt;
      let repairsUsed = await this.#repairMissingRoutes(claim.run, finalState.outputs);
      for (; ; repairsUsed += 1) {
        try {
          validatedAttempt = attempt.attempt + repairsUsed * REPAIR_ATTEMPT_STRIDE;
          validationLease = await this.#validator?.validate({
            run: claim.run,
            attempt: validatedAttempt,
          });
          break;
        } catch (validationError) {
          const failure = findValidationFailure(validationError);
          if (
            this.#repairer === undefined ||
            failure === undefined ||
            repairsUsed >= this.#maxRepairAttempts ||
            !isRepairableValidationStep(failure.step)
          ) {
            throw validationError;
          }
          let repaired = false;
          try {
            repaired = await this.#repairer.repair({
              run: claim.run,
              failure,
              upstreamOutputs: parseUpstreamOutputs(finalState.outputs),
              repairAttempt: repairsUsed + 1,
            });
          } catch (repairError) {
            if (findRunStoppedError(repairError) !== null) throw repairError;
            // A repair that itself fails must not hide why the run failed:
            // report the original validation failure, and log the repair's.
            console.error(
              `Automatic repair ${String(repairsUsed + 1)} failed for run ${claim.run.id}:`,
              repairError instanceof Error ? repairError.message : repairError,
            );
          }
          if (!repaired) throw validationError;
        }
      }

      // Observe-only: its result is not consulted here, and a defensive
      // catch here (on top of ReleaseAssessor's own internal fail-closed
      // handling) guarantees a QA assessment can never affect run
      // completion, retries, or failure -- even if a future assessor
      // implementation does not uphold that contract itself.
      await this.#assessor?.assess({
        run: claim.run,
        attempt: validatedAttempt,
      }).catch(() => undefined);

      const completed = await this.#repository.completeRun(
        claim.run.id,
        claim.run.controlVersion,
        this.#now(),
      );
      if (completed) return { outcome: "completed" };
      await validationLease?.revoke();
      return { outcome: "stopped", status: "stale" };
    } catch (error) {
      await validationLease?.revoke().catch(() => undefined);
      const stopped = findRunStoppedError(error);
      if (stopped !== null) {
        return { outcome: "stopped", status: stopped.status };
      }
      if (isRetryableError(error) && attempt.attempt < attempt.maxAttempts) {
        throw error;
      }

      const failed = await this.#repository.failRun(
        claim.run.id,
        claim.run.controlVersion,
        toWorkerError(error),
        this.#now(),
      );
      return failed
        ? { outcome: "failed" }
        : { outcome: "stopped", status: "stale" };
    }
  }
}

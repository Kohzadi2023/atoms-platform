import type { AgentRuntime } from "@atoms/agents";
import { RunJobSchema, type RunJob } from "@atoms/contracts";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

import type { WorkerRepository } from "./domain.js";
import {
  findRunStoppedError,
  isRetryableError,
  toWorkerError,
} from "./errors.js";
import { buildRunGraph } from "./graph.js";
import type { RunValidationLease, RunValidator } from "./validation.js";
import type { RunAttachmentLoader } from "./attachment-loader.js";

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
  readonly attachmentLoader?: RunAttachmentLoader;
  readonly now?: () => Date;
}

export class RunProcessor {
  readonly #repository: WorkerRepository;
  readonly #now: () => Date;
  readonly #graph: ReturnType<typeof buildRunGraph>;
  readonly #validator: RunValidator | undefined;

  constructor(options: RunProcessorOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
    this.#graph = buildRunGraph(options);
    this.#validator = options.validator;
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
      await this.#graph.invoke(
        {
          runId: claim.run.id,
          workspaceId: claim.run.workspaceId,
          projectId: claim.run.projectId,
          prompt: claim.run.prompt,
          command: job.command,
          controlVersion: claim.run.controlVersion,
          outputs: {},
        },
        {
          configurable: {
            thread_id: claim.run.id,
            checkpoint_ns: `job:${job.command}:${String(job.controlVersion)}`,
          },
        },
      );

      validationLease = await this.#validator?.validate({
        run: claim.run,
        attempt: attempt.attempt,
      });

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

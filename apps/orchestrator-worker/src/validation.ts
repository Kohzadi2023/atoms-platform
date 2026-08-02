import type { AgentProjectFile } from "@atoms/agents";
import type { JsonValue } from "@atoms/contracts";
import {
  type PreviewSessionStore,
  type PreviewTicketSigner,
} from "@atoms/preview";
import {
  type ProjectValidationResult,
  type ProjectValidationRunner,
  type SandboxHandle,
  type ValidationStepReport,
} from "@atoms/sandbox-provider";

import type { RunExecutionRecord } from "./domain.js";
import { RunStoppedError, toWorkerError } from "./errors.js";

export interface RunValidationInput {
  readonly run: RunExecutionRecord;
  readonly attempt: number;
}

export interface RunValidator {
  validate(input: RunValidationInput): Promise<RunValidationLease | void>;
}

export interface RunValidationLease {
  revoke(): Promise<void>;
}

export type SandboxSessionMutationResult =
  | { readonly kind: "ok"; readonly sandboxSessionId: string }
  | { readonly kind: "stopped" };

export interface CreateSandboxSessionInput {
  readonly run: RunExecutionRecord;
  readonly attempt: number;
  readonly externalId: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface RecordSandboxCommandInput {
  readonly runId: string;
  readonly expectedControlVersion: number;
  readonly sandboxSessionId: string;
  readonly step: ValidationStepReport;
  readonly now: Date;
}

export interface RecordPreviewReadyInput {
  readonly run: RunExecutionRecord;
  readonly sandboxSessionId: string;
  readonly gatewayUrl: string;
  readonly processId: number;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface Phase2ValidationRepository {
  listProjectFiles(projectId: string): Promise<readonly AgentProjectFile[]>;
  createSandboxSession(
    input: CreateSandboxSessionInput,
  ): Promise<SandboxSessionMutationResult>;
  markSandboxFilesRestored(
    runId: string,
    expectedControlVersion: number,
    sandboxSessionId: string,
    now: Date,
  ): Promise<boolean>;
  recordSandboxCommand(input: RecordSandboxCommandInput): Promise<boolean>;
  recordPreviewReady(input: RecordPreviewReadyInput): Promise<boolean>;
  markSandboxFailed(
    sandboxSessionId: string,
    error: JsonValue,
    now: Date,
  ): Promise<void>;
  markPreviewStopped(sandboxSessionId: string, now: Date): Promise<void>;
}

interface ValidationRunner {
  validate(
    input: Parameters<ProjectValidationRunner["validate"]>[0],
  ): Promise<ProjectValidationResult>;
  terminate(sandboxId: string): Promise<void>;
}

export interface Phase2RunValidatorOptions {
  readonly repository: Phase2ValidationRepository;
  readonly runner: ValidationRunner;
  readonly previewStore: PreviewSessionStore;
  readonly previewSigner: PreviewTicketSigner;
  readonly now?: () => Date;
}

export class Phase2RunValidator implements RunValidator {
  readonly #repository: Phase2ValidationRepository;
  readonly #runner: ValidationRunner;
  readonly #previewStore: PreviewSessionStore;
  readonly #previewSigner: PreviewTicketSigner;
  readonly #now: () => Date;

  constructor(options: Phase2RunValidatorOptions) {
    this.#repository = options.repository;
    this.#runner = options.runner;
    this.#previewStore = options.previewStore;
    this.#previewSigner = options.previewSigner;
    this.#now = options.now ?? (() => new Date());
  }

  async validate(input: RunValidationInput): Promise<RunValidationLease> {
    const files = await this.#repository.listProjectFiles(input.run.projectId);
    let sandboxSessionId: string | undefined;
    let sandbox: SandboxHandle | undefined;
    let result: ProjectValidationResult | undefined;

    try {
      result = await this.#runner.validate({
        files: files.map((file) => ({
          path: file.path,
          content: file.content,
        })),
        metadata: {
          workspaceId: input.run.workspaceId,
          projectId: input.run.projectId,
          runId: input.run.id,
          attempt: String(input.attempt),
        },
        hooks: {
          onSandboxCreated: async (created, expiresAt) => {
            sandbox = created;
            const mutation = await this.#repository.createSandboxSession({
              run: input.run,
              attempt: input.attempt,
              externalId: created.id,
              expiresAt: new Date(expiresAt),
              now: this.#now(),
            });
            if (mutation.kind === "stopped") {
              throw new RunStoppedError(
                "Run stopped while the sandbox was being recorded",
                "stopped",
              );
            }
            sandboxSessionId = mutation.sandboxSessionId;
          },
          onFilesRestored: async () => {
            const sessionId = requireSessionId(sandboxSessionId);
            const active = await this.#repository.markSandboxFilesRestored(
              input.run.id,
              input.run.controlVersion,
              sessionId,
              this.#now(),
            );
            if (!active) {
              throw new RunStoppedError(
                "Run stopped after restoring the project revision",
                "stopped",
              );
            }
          },
          onStep: async (_activeSandbox, step) => {
            const sessionId = requireSessionId(sandboxSessionId);
            const active = await this.#repository.recordSandboxCommand({
              runId: input.run.id,
              expectedControlVersion: input.run.controlVersion,
              sandboxSessionId: sessionId,
              step,
              now: this.#now(),
            });
            if (!active) {
              throw new RunStoppedError(
                "Run stopped during sandbox validation",
                "stopped",
              );
            }
          },
        },
      });

      const completedResult = result;
      const sessionId = requireSessionId(sandboxSessionId);
      const expiresAt = new Date(completedResult.expiresAt);
      const gatewayUrl = this.#previewSigner.issue(sessionId, expiresAt);
      await this.#previewStore.put({
        sessionId,
        workspaceId: input.run.workspaceId,
        projectId: input.run.projectId,
        runId: input.run.id,
        upstreamUrl: completedResult.preview.url,
        requestHeaders: { ...(completedResult.preview.requestHeaders ?? {}) },
        expiresAt: completedResult.expiresAt,
      });
      const active = await this.#repository.recordPreviewReady({
        run: input.run,
        sandboxSessionId: sessionId,
        gatewayUrl,
        processId: completedResult.previewProcessId,
        expiresAt,
        now: this.#now(),
      });
      if (!active) {
        throw new RunStoppedError(
          "Run stopped before the preview became visible",
          "stopped",
        );
      }
      let revoked = false;
      return {
        revoke: async () => {
          if (revoked) return;
          revoked = true;
          const cleanup = await Promise.allSettled([
            this.#previewStore.delete(sessionId),
            this.#runner.terminate(completedResult.sandbox.id),
            this.#repository.markPreviewStopped(sessionId, this.#now()),
          ]);
          const failures = cleanup
            .filter(
              (item): item is PromiseRejectedResult =>
                item.status === "rejected",
            )
            .map((item) => item.reason);
          if (failures.length > 0) {
            throw new AggregateError(failures, "Preview lease cleanup failed");
          }
        },
      };
    } catch (error) {
      if (sandboxSessionId !== undefined) {
        await this.#previewStore.delete(sandboxSessionId).catch(() => undefined);
        await this.#repository
          .markSandboxFailed(
            sandboxSessionId,
            toWorkerError(error),
            this.#now(),
          )
          .catch(() => undefined);
      }
      if (result !== undefined) {
        await this.#runner.terminate(result.sandbox.id).catch(() => undefined);
      } else if (sandbox !== undefined) {
        // The runner normally handles this path; termination is idempotent and
        // this closes the window if a custom runner failed before cleanup.
        await this.#runner.terminate(sandbox.id).catch(() => undefined);
      }
      throw error;
    }
  }
}

function requireSessionId(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("Sandbox session was not persisted before lifecycle update");
  }
  return value;
}

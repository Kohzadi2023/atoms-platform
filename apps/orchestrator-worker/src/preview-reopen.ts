import { randomBytes } from "node:crypto";

import type { AgentProjectFile } from "@atoms/agents";
import type { JsonValue, PreviewReopenJob } from "@atoms/contracts";
import type { PreviewSessionStore, PreviewTicketSigner } from "@atoms/preview";
import type {
  ProjectValidationResult,
  ProjectValidationRunner,
  SandboxHandle,
} from "@atoms/sandbox-provider";

import { toWorkerError } from "./errors.js";

/**
 * Sandbox attempt numbers a run uses for itself are 1 and its repairs at 101,
 * 201, 301. A re-opened preview starts well above them so the two never collide.
 */
export const PREVIEW_REOPEN_FIRST_ATTEMPT = 1_001;

export interface CreatePreviewReopenSessionInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly externalId: string;
  readonly expiresAt: Date;
}

export interface RecordPreviewReopenedInput {
  readonly sandboxSessionId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly gatewayUrl: string;
  readonly processId: number;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface RecordPreviewReopenFailedInput {
  readonly runId: string;
  readonly sandboxSessionId: string | undefined;
  readonly error: JsonValue;
  readonly now: Date;
}

export interface PreviewReopenRepository {
  listProjectFiles(projectId: string): Promise<readonly AgentProjectFile[]>;
  createPreviewReopenSession(
    input: CreatePreviewReopenSessionInput,
  ): Promise<string | null>;
  recordPreviewReopened(input: RecordPreviewReopenedInput): Promise<void>;
  recordPreviewReopenFailed(input: RecordPreviewReopenFailedInput): Promise<void>;
}

interface PreviewRunner {
  validate(
    input: Parameters<ProjectValidationRunner["validate"]>[0],
  ): Promise<ProjectValidationResult>;
  terminate(sandboxId: string): Promise<void>;
}

export interface PreviewReopenProcessorOptions {
  readonly repository: PreviewReopenRepository;
  readonly runner: PreviewRunner;
  readonly previewStore: PreviewSessionStore;
  readonly previewSigner: PreviewTicketSigner;
  readonly now?: () => Date;
}

/**
 * Restores a finished project's saved files into a fresh sandbox and starts its
 * preview, without a run: no agent executes and no model is called. The only cost
 * is sandbox time, bounded by the same expiry as any preview.
 */
export class PreviewReopenProcessor {
  readonly #repository: PreviewReopenRepository;
  readonly #runner: PreviewRunner;
  readonly #previewStore: PreviewSessionStore;
  readonly #previewSigner: PreviewTicketSigner;
  readonly #now: () => Date;

  constructor(options: PreviewReopenProcessorOptions) {
    this.#repository = options.repository;
    this.#runner = options.runner;
    this.#previewStore = options.previewStore;
    this.#previewSigner = options.previewSigner;
    this.#now = options.now ?? (() => new Date());
  }

  async process(job: PreviewReopenJob): Promise<void> {
    const files = await this.#repository.listProjectFiles(job.projectId);
    if (files.length === 0) {
      await this.#repository.recordPreviewReopenFailed({
        runId: job.runId,
        sandboxSessionId: undefined,
        error: { message: "The project has no saved files to preview." },
        now: this.#now(),
      });
      return;
    }

    let sandboxSessionId: string | undefined;
    let sandbox: SandboxHandle | undefined;
    let result: ProjectValidationResult | undefined;
    try {
      result = await this.#runner.validate({
        files: files.map((file) => ({ path: file.path, content: file.content })),
        metadata: {
          workspaceId: job.workspaceId,
          projectId: job.projectId,
          runId: job.runId,
          purpose: "preview-reopen",
        },
        previewOnly: true,
        hooks: {
          onSandboxCreated: async (created, expiresAt) => {
            sandbox = created;
            const id = await this.#repository.createPreviewReopenSession({
              projectId: job.projectId,
              workspaceId: job.workspaceId,
              runId: job.runId,
              externalId: created.id,
              expiresAt: new Date(expiresAt),
            });
            if (id === null) {
              throw new PreviewReopenNotApplicableError();
            }
            sandboxSessionId = id;
          },
          // Same as a run's preview: the app is told its own public address and a
          // session secret before it starts, or a sign-in framework answers 500.
          previewEnvironment: (_activeSandbox, previewExpiresAt) => {
            const publicUrl = this.#previewSigner
              .issue(requireSessionId(sandboxSessionId), new Date(previewExpiresAt))
              .replace(/\/$/u, "");
            const secret = randomBytes(32).toString("base64url");
            return {
              NEXTAUTH_URL: publicUrl,
              NEXTAUTH_SECRET: secret,
              AUTH_SECRET: secret,
            };
          },
        },
      });

      const sessionId = requireSessionId(sandboxSessionId);
      const expiresAt = new Date(result.expiresAt);
      const gatewayUrl = this.#previewSigner.issue(sessionId, expiresAt);
      await this.#previewStore.put({
        sessionId,
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        runId: job.runId,
        upstreamUrl: result.preview.url,
        requestHeaders: { ...(result.preview.requestHeaders ?? {}) },
        expiresAt: result.expiresAt,
      });
      await this.#repository.recordPreviewReopened({
        sandboxSessionId: sessionId,
        projectId: job.projectId,
        workspaceId: job.workspaceId,
        runId: job.runId,
        gatewayUrl,
        processId: result.previewProcessId,
        expiresAt,
        now: this.#now(),
      });
    } catch (error) {
      if (sandboxSessionId !== undefined) {
        await this.#previewStore.delete(sandboxSessionId).catch(() => undefined);
      }
      if (result !== undefined) {
        await this.#runner.terminate(result.sandbox.id).catch(() => undefined);
      } else if (sandbox !== undefined) {
        await this.#runner.terminate(sandbox.id).catch(() => undefined);
      }
      // A run that is not finished (or not this project's) is not an error to
      // report to the UI or to retry; there is simply nothing to reopen.
      if (error instanceof PreviewReopenNotApplicableError) return;
      await this.#repository
        .recordPreviewReopenFailed({
          runId: job.runId,
          sandboxSessionId,
          error: toWorkerError(error),
          now: this.#now(),
        })
        .catch(() => undefined);
      // Not rethrown: the failure is recorded for the UI, and a queue retry would
      // only rebuild the same sandbox for another few minutes of spend.
    }
  }
}

class PreviewReopenNotApplicableError extends Error {
  constructor() {
    super("The run is not a completed run of this project; there is no preview to reopen");
    this.name = "PreviewReopenNotApplicableError";
  }
}

function requireSessionId(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("The preview sandbox session was not recorded before it was used");
  }
  return value;
}

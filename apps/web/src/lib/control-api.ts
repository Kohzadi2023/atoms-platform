import {
  AttachmentListResponseSchema,
  AttachmentUploadIntentResponseSchema,
  FileContentResponseSchema,
  IdempotencyKeySchema,
  ProjectAttachmentSchema,
  ProjectFileListResponseSchema,
  ProjectResponseSchema,
  RunEventEnvelopeSchema,
  RunArtifactListResponseSchema,
  RunActionInputSchema,
  RunResponseSchema,
  type CreateProjectInput,
  type AttachmentListResponse,
  type AttachmentUploadIntentResponse,
  type CreateAttachmentUploadIntentInput,
  type FileContentResponse,
  type ProjectFileListResponse,
  type ProjectResponse,
  type ProjectAttachment,
  type RunActionInput,
  type RunArtifactListResponse,
  type RunEventEnvelope,
  type RunResponse,
} from "@atoms/contracts";
import type { ZodType } from "zod";

export class ControlApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ControlApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ControlApiClientOptions {
  readonly baseUrl: string;
}

export class ControlApiClient {
  readonly #baseUrl: string;

  constructor(options: ControlApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
  }

  createProject(input: CreateProjectInput): Promise<ProjectResponse> {
    return this.#request("/v1/projects", ProjectResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getProject(projectId: string, signal?: AbortSignal): Promise<ProjectResponse> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}`,
      ProjectResponseSchema,
      signal === undefined ? {} : { signal },
    );
  }

  createRun(
    projectId: string,
    prompt: string,
    idempotencyKey: string,
    attachmentIds: readonly string[] = [],
  ): Promise<RunResponse> {
    const normalizedKey = IdempotencyKeySchema.parse(idempotencyKey);
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/runs`,
      RunResponseSchema,
      {
        method: "POST",
        headers: { "Idempotency-Key": normalizedKey },
        body: JSON.stringify({ prompt, attachmentIds }),
      },
    );
  }

  createAttachmentUploadIntent(
    projectId: string,
    input: CreateAttachmentUploadIntentInput,
  ): Promise<AttachmentUploadIntentResponse> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/attachments/upload-intents`,
      AttachmentUploadIntentResponseSchema,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  completeAttachmentUpload(
    projectId: string,
    attachmentId: string,
    etag?: string,
  ): Promise<ProjectAttachment> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}/complete`,
      ProjectAttachmentSchema,
      {
        method: "POST",
        body: JSON.stringify(etag === undefined ? {} : { etag }),
      },
    );
  }

  listProjectAttachments(projectId: string): Promise<AttachmentListResponse> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/attachments`,
      AttachmentListResponseSchema,
    );
  }

  getRun(runId: string, signal?: AbortSignal): Promise<RunResponse> {
    return this.#request(
      `/v1/runs/${encodeURIComponent(runId)}`,
      RunResponseSchema,
      signal === undefined ? {} : { signal },
    );
  }

  runAction(runId: string, input: RunActionInput) {
    const parsed = RunActionInputSchema.parse(input);
    return this.#request(
      `/v1/runs/${encodeURIComponent(runId)}/actions`,
      RunResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(parsed),
      },
    );
  }

  listRunArtifacts(runId: string): Promise<RunArtifactListResponse> {
    return this.#request(
      `/v1/runs/${encodeURIComponent(runId)}/artifacts`,
      RunArtifactListResponseSchema,
    );
  }

  listProjectFiles(projectId: string): Promise<ProjectFileListResponse> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/files`,
      ProjectFileListResponseSchema,
    );
  }

  getProjectFile(
    projectId: string,
    filePath: string,
    version?: number,
  ): Promise<FileContentResponse> {
    const query = new URLSearchParams({ filePath });
    if (version !== undefined) query.set("version", String(version));
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/files/content?${query.toString()}`,
      FileContentResponseSchema,
    );
  }

  putProjectFile(
    projectId: string,
    filePath: string,
    content: string,
    expectedVersion: number,
  ): Promise<FileContentResponse> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/files/content`,
      FileContentResponseSchema,
      {
        method: "PUT",
        body: JSON.stringify({ filePath, content, expectedVersion }),
      },
    );
  }

  async streamRunEvents(input: {
    readonly runId: string;
    readonly afterSequence: number;
    readonly signal: AbortSignal;
    readonly onEvent: (event: RunEventEnvelope) => void;
    readonly onConnectionChange?: (connected: boolean) => void;
  }): Promise<void> {
    let cursor = input.afterSequence;
    while (!input.signal.aborted) {
      const response = await fetch(
        `${this.#baseUrl}/v1/runs/${encodeURIComponent(input.runId)}/events`,
        {
          headers: {
            Accept: "text/event-stream",
            "Last-Event-ID": String(cursor),
          },
          cache: "no-store",
          credentials: "omit",
          signal: input.signal,
        },
      );
      if (!response.ok || response.body === null) {
        throw await toControlApiError(response);
      }

      input.onConnectionChange?.(true);
      try {
        for await (const event of parseEventStream(response.body, input.signal)) {
          if (event.sequence <= cursor) continue;
          cursor = event.sequence;
          input.onEvent(event);
        }
      } finally {
        input.onConnectionChange?.(false);
      }

      if (input.signal.aborted) return;
      const run = await this.getRun(input.runId, input.signal);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) return;
      await abortableDelay(750, input.signal);
    }
  }

  async #request<T>(
    path: string,
    schema: ZodType<T>,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) throw await toControlApiError(response);
    return schema.parse(await response.json());
  }
}

async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<RunEventEnvelope> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/gu, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data.length > 0) yield RunEventEnvelopeSchema.parse(JSON.parse(data));
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function toControlApiError(response: Response): Promise<ControlApiError> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    const code =
      typeof body.error?.code === "string" ? body.error.code : "REQUEST_FAILED";
    const message =
      typeof body.error?.message === "string"
        ? body.error.message
        : `Control API request failed (${String(response.status)})`;
    return new ControlApiError(response.status, code, message, body.error?.details);
  } catch {
    return new ControlApiError(
      response.status,
      "REQUEST_FAILED",
      `Control API request failed (${String(response.status)})`,
    );
  }
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(resolve, durationMs);
    signal.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

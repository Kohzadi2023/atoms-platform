import {
  CreateRunHeadersSchema,
  CreateProjectInputSchema,
  CreateRunInputSchema,
  FileContentInputSchema,
  ProjectFileListResponseSchema,
  FileContentQuerySchema,
  FileContentResponseSchema,
  ProjectResponseSchema,
  RunArtifactListResponseSchema,
  RunActionInputSchema,
  RunEventEnvelopeSchema,
  RunResponseSchema,
  validateRunEventPayload,
  type AgentRunStatus,
  type JsonValue,
  type RunAction,
} from "@atoms/contracts";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";

import {
  toFileContentResponse,
  toProjectFileSummary,
  toProjectResponse,
  toRunArtifactResponse,
  toRunResponse,
  type RunRecord,
  type RunStatusPatch,
} from "./domain.js";
import { ApiError, RepositoryConflictError } from "./errors.js";
import {
  registerDatabaseRoutes,
  type DatabaseRoutesOptions,
} from "./database-routes.js";
import {
  registerAttachmentRoutes,
  type AttachmentRoutesOptions,
} from "./attachment-routes.js";
import type {
  ControlRepository,
  CreateRunWithIdempotencyResult,
} from "./repository.js";
import type { RunQueue } from "./run-queue.js";
import { RepositoryAttachmentError } from "./errors.js";

const ProjectIdParamsSchema = z
  .object({ id: z.string().uuid() })
  .strict();
const RunIdParamsSchema = z
  .object({ runId: z.string().uuid() })
  .strict();
const SseHeadersSchema = z
  .object({
    "last-event-id": z.string().trim().regex(/^\d+$/).optional(),
  })
  .passthrough();
const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();

const errorResponses = {
  400: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  500: ErrorResponseSchema,
  503: ErrorResponseSchema,
} as const;

const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export interface BuildControlApiOptions {
  readonly repository: ControlRepository;
  readonly runQueue: RunQueue;
  readonly logger?: boolean;
  readonly closeDependencies?: boolean;
  readonly ssePollIntervalMs?: number;
  readonly sseHeartbeatMs?: number;
  readonly sseMaxConnectionMs?: number;
  readonly now?: () => Date;
  readonly corsOrigins?: readonly string[];
  readonly databaseOperations?: DatabaseRoutesOptions;
  readonly attachmentOperations?: AttachmentRoutesOptions;
}

export async function buildControlApi(
  options: BuildControlApiOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const corsOrigins = options.corsOrigins ?? [];
  await app.register(cors, {
    origin: corsOrigins.length === 0 ? false : [...corsOrigins],
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["content-type", "last-event-id", "idempotency-key"],
  });

  const api = app.withTypeProvider<ZodTypeProvider>();
  const now = options.now ?? (() => new Date());

  if (options.databaseOperations !== undefined) {
    registerDatabaseRoutes(api, {
      ...options.databaseOperations,
      now,
    });
  }
  if (options.attachmentOperations !== undefined) {
    registerAttachmentRoutes(api, {
      ...options.attachmentOperations,
      now,
    });
  }

  api.post(
    "/v1/projects",
    {
      schema: {
        operationId: "createProject",
        body: CreateProjectInputSchema,
        response: { 201: ProjectResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      try {
        const project = await options.repository.createProject(request.body);
        return reply.code(201).send(toProjectResponse(project));
      } catch (error) {
        if (error instanceof RepositoryConflictError) {
          throw new ApiError(409, "PROJECT_SLUG_CONFLICT", error.message, {
            constraint: error.constraint,
          });
        }
        throw error;
      }
    },
  );

  api.get(
    "/v1/projects/:id",
    {
      schema: {
        operationId: "getProject",
        params: ProjectIdParamsSchema,
        response: { 200: ProjectResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const project = await options.repository.getProject(request.params.id);
      if (project === null) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
      }
      return reply.code(200).send(toProjectResponse(project));
    },
  );

  api.post(
    "/v1/projects/:id/runs",
    {
      schema: {
        operationId: "createRun",
        params: ProjectIdParamsSchema,
        headers: CreateRunHeadersSchema,
        body: CreateRunInputSchema,
        response: { 200: RunResponseSchema, 201: RunResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      let result: CreateRunWithIdempotencyResult;
      try {
        result = await options.repository.createRunWithIdempotency(
          request.params.id,
          request.body.prompt,
          request.headers["idempotency-key"],
          request.body.attachmentIds,
        );
      } catch (error) {
        if (error instanceof RepositoryAttachmentError) {
          throw new ApiError(
            409,
            "RUN_ATTACHMENTS_NOT_READY",
            "Every run attachment must be clean and belong to the project",
            { attachmentIds: [...error.attachmentIds] },
          );
        }
        throw error;
      }
      if (result.kind === "project_not_found") {
        throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
      }
      if (result.kind === "idempotency_conflict") {
        throw new ApiError(
          409,
          "IDEMPOTENCY_KEY_CONFLICT",
          "The idempotency key was already used for a different run request",
          {
            runId: result.run.id,
            status: result.run.status,
            controlVersion: result.run.controlVersion,
          },
        );
      }

      const run = result.run;

      if (result.replayed) {
        return reply.code(200).send(toRunResponse(run));
      }

      try {
        await options.runQueue.enqueue({
          runId: run.id,
          command: "start",
          controlVersion: run.controlVersion,
        });
      } catch (error) {
        await options.repository.markRunFailed(
          run.id,
          run.controlVersion,
          providerFailure("QUEUE_ENQUEUE_FAILED", error),
        );
        throw new ApiError(
          503,
          "RUN_QUEUE_UNAVAILABLE",
          "Run was persisted but could not be enqueued",
        );
      }

      return reply.code(201).send(toRunResponse(run));
    },
  );

  api.get(
    "/v1/runs/:runId",
    {
      schema: {
        operationId: "getRun",
        params: RunIdParamsSchema,
        response: { 200: RunResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const run = await options.repository.getRun(request.params.runId);
      if (run === null) {
        throw new ApiError(404, "RUN_NOT_FOUND", "Run not found");
      }
      return reply.code(200).send(toRunResponse(run));
    },
  );

  api.get(
    "/v1/runs/:runId/artifacts",
    {
      schema: {
        operationId: "listRunArtifacts",
        params: RunIdParamsSchema,
        response: { 200: RunArtifactListResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const run = await options.repository.getRun(request.params.runId);
      if (run === null) {
        throw new ApiError(404, "RUN_NOT_FOUND", "Run not found");
      }
      const artifacts = await options.repository.listRunArtifacts(run.id);
      return reply.code(200).send({
        items: artifacts.map(toRunArtifactResponse),
      });
    },
  );

  api.get(
    "/v1/runs/:runId/events",
    {
      schema: {
        operationId: "streamRunEvents",
        params: RunIdParamsSchema,
        headers: SseHeadersSchema,
        response: errorResponses,
      },
    },
    async (request, reply) => {
      const run = await options.repository.getRun(request.params.runId);
      if (run === null) {
        throw new ApiError(404, "RUN_NOT_FOUND", "Run not found");
      }

      let cursor = parseLastEventId(request.headers["last-event-id"]);
      const pollIntervalMs = options.ssePollIntervalMs ?? 500;
      const heartbeatMs = options.sseHeartbeatMs ?? 15_000;
      const maxConnectionMs = options.sseMaxConnectionMs ?? 30 * 60_000;
      const connectedAt = Date.now();
      let lastWriteAt = connectedAt;
      let disconnected = false;

      reply.hijack();
      reply.raw.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      });
      reply.raw.flushHeaders();
      reply.raw.once("close", () => {
        disconnected = true;
      });

      try {
        while (!disconnected && Date.now() - connectedAt < maxConnectionMs) {
          const events = await options.repository.listRunEventsAfter(
            run.id,
            cursor,
            100,
          );
          for (const event of events) {
            const payload = validateRunEventPayload(
              event.eventType,
              event.payload,
            );
            const envelope = RunEventEnvelopeSchema.parse({
              sequence: event.sequence,
              runId: event.runId,
              eventType: event.eventType,
              payload,
              occurredAt: event.createdAt.toISOString(),
            });
            reply.raw.write(
              `id: ${String(envelope.sequence)}\nevent: ${envelope.eventType}\ndata: ${JSON.stringify(envelope)}\n\n`,
            );
            cursor = envelope.sequence;
            lastWriteAt = Date.now();
          }

          if (events.length === 100) {
            continue;
          }

          const latestRun = await options.repository.getRun(run.id);
          if (
            latestRun === null ||
            TERMINAL_RUN_STATUSES.has(latestRun.status)
          ) {
            break;
          }

          if (Date.now() - lastWriteAt >= heartbeatMs) {
            reply.raw.write(`: heartbeat ${String(Date.now())}\n\n`);
            lastWriteAt = Date.now();
          }
          await delay(pollIntervalMs);
        }
      } finally {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    },
  );

  api.post(
    "/v1/runs/:runId/actions",
    {
      schema: {
        operationId: "controlRun",
        params: RunIdParamsSchema,
        body: RunActionInputSchema,
        response: { 200: RunResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const current = await options.repository.getRun(request.params.runId);
      if (current === null) {
        throw new ApiError(404, "RUN_NOT_FOUND", "Run not found");
      }
      assertClientPreconditions(
        current,
        request.body.expectedStatus,
        request.body.expectedControlVersion,
      );

      const transition = resolveRunTransition(
        request.body.action,
        current.status,
        now(),
      );
      const updated = await options.repository.transitionRun(
        current.id,
        current.status,
        current.controlVersion,
        transition.patch,
      );
      if (updated === null) {
        const latest = await options.repository.getRun(current.id);
        throw concurrencyError(latest);
      }

      if (transition.enqueue) {
        try {
          await options.runQueue.enqueue({
            runId: updated.id,
            command: request.body.action as "approve" | "resume" | "retry",
            controlVersion: updated.controlVersion,
            ...(request.body.reason === undefined
              ? {}
              : { reason: request.body.reason }),
            ...(request.body.action === "approve"
              ? { approvalScope: request.body.approvalScope }
              : {}),
          });
        } catch (error) {
          await options.repository.markRunFailed(
            updated.id,
            updated.controlVersion,
            providerFailure("QUEUE_ENQUEUE_FAILED", error),
          );
          throw new ApiError(
            503,
            "RUN_QUEUE_UNAVAILABLE",
            "Run state changed but execution could not be enqueued",
          );
        }
      }

      return reply.code(200).send(toRunResponse(updated));
    },
  );

  api.get(
    "/v1/projects/:id/files",
    {
      schema: {
        operationId: "listProjectFiles",
        params: ProjectIdParamsSchema,
        response: { 200: ProjectFileListResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const files = await options.repository.listProjectFiles(request.params.id);
      if (files === null) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
      }
      return reply.code(200).send({
        items: files.map(toProjectFileSummary),
      });
    },
  );

  api.get(
    "/v1/projects/:id/files/content",
    {
      schema: {
        operationId: "getProjectFileContent",
        params: ProjectIdParamsSchema,
        querystring: FileContentQuerySchema,
        response: { 200: FileContentResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const file = await options.repository.getProjectFile(
        request.params.id,
        request.query.filePath,
        request.query.version,
      );
      if (file === null) {
        throw new ApiError(404, "PROJECT_FILE_NOT_FOUND", "Project file not found");
      }
      return reply.code(200).send(toFileContentResponse(file));
    },
  );

  api.put(
    "/v1/projects/:id/files/content",
    {
      schema: {
        operationId: "putProjectFileContent",
        params: ProjectIdParamsSchema,
        body: FileContentInputSchema,
        response: { 200: FileContentResponseSchema, 201: FileContentResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const result = await options.repository.putProjectFile(
        request.params.id,
        request.body,
      );
      if (result.kind === "project_not_found") {
        throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
      }
      if (result.kind === "version_conflict") {
        throw new ApiError(
          409,
          "PROJECT_FILE_VERSION_CONFLICT",
          "The project file has changed since it was read",
          {
            expectedVersion: request.body.expectedVersion,
            actualVersion: result.actualVersion,
          },
        );
      }
      const statusCode = result.file.version === 1 ? 201 : 200;
      return reply.code(statusCode).send(toFileContentResponse(result.file));
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation !== undefined
    ) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
        },
      });
    }

    request.log.error({ err: error }, "Unhandled control API error");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
      },
    });
  });

  if (options.closeDependencies ?? false) {
    app.addHook("onClose", async () => {
      await options.databaseOperations?.queue.close();
      await options.attachmentOperations?.queue.close();
      await options.attachmentOperations?.repository.close();
      await options.runQueue.close();
      await options.repository.close();
    });
  }

  await app.ready();
  return app;
}

function parseLastEventId(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new ApiError(
      400,
      "INVALID_LAST_EVENT_ID",
      "Last-Event-ID must be a non-negative 32-bit integer",
    );
  }
  return parsed;
}

function assertClientPreconditions(
  current: RunRecord,
  expectedStatus: AgentRunStatus | undefined,
  expectedControlVersion: number | undefined,
): void {
  if (
    (expectedStatus !== undefined && expectedStatus !== current.status) ||
    (expectedControlVersion !== undefined &&
      expectedControlVersion !== current.controlVersion)
  ) {
    throw concurrencyError(current);
  }
}

function concurrencyError(current: RunRecord | null): ApiError {
  return new ApiError(
    409,
    "RUN_CONCURRENCY_CONFLICT",
    "The run changed before the action could be applied",
    current === null
      ? { current: null }
      : {
          current: {
            status: current.status,
            controlVersion: current.controlVersion,
          },
        },
  );
}

function resolveRunTransition(
  action: RunAction,
  currentStatus: AgentRunStatus,
  occurredAt: Date,
): { readonly patch: RunStatusPatch; readonly enqueue: boolean } {
  const invalid = (): never => {
    throw new ApiError(
      409,
      "INVALID_RUN_TRANSITION",
      `Action ${action} is not valid while run status is ${currentStatus}`,
      { action, currentStatus },
    );
  };

  switch (action) {
    case "pause":
      if (currentStatus !== "PENDING" && currentStatus !== "RUNNING") invalid();
      return {
        patch: { status: "PAUSED", pausedAt: occurredAt },
        enqueue: false,
      };
    case "resume":
    case "approve":
      if (currentStatus !== "PAUSED") invalid();
      return {
        patch: { status: "PENDING", pausedAt: null },
        enqueue: true,
      };
    case "cancel":
      if (
        currentStatus !== "PENDING" &&
        currentStatus !== "RUNNING" &&
        currentStatus !== "PAUSED"
      ) {
        invalid();
      }
      return {
        patch: { status: "CANCELLED", cancelledAt: occurredAt },
        enqueue: false,
      };
    case "retry":
      if (currentStatus !== "FAILED") invalid();
      return {
        patch: {
          status: "PENDING",
          error: null,
          startedAt: null,
          pausedAt: null,
          completedAt: null,
          cancelledAt: null,
        },
        enqueue: true,
      };
  }
}

function providerFailure(code: string, error: unknown): JsonValue {
  return {
    code,
    message: error instanceof Error ? error.message : "Provider operation failed",
    retryable: true,
  };
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

import { PreviewReopenResponseSchema } from "@atoms/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ApiError } from "./errors.js";
import type { PreviewReopenQueue } from "./preview-reopen-queue.js";
import type { PreviewReopenRepository } from "./preview-reopen-repository.js";

const ProjectParamsSchema = z.object({ id: z.string().uuid() }).strict();

export interface PreviewReopenRoutesOptions {
  readonly repository: PreviewReopenRepository;
  readonly queue: PreviewReopenQueue;
  readonly now?: () => Date;
}

export function registerPreviewReopenRoutes(
  app: FastifyInstance,
  options: PreviewReopenRoutesOptions,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const now = options.now ?? (() => new Date());

  api.post(
    "/v1/projects/:id/preview/reopen",
    {
      schema: {
        operationId: "reopenProjectPreview",
        params: ProjectParamsSchema,
        response: { 202: PreviewReopenResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const target = await options.repository.findReopenTarget({
        userId: principal.userId,
        projectId: request.params.id,
        now: now(),
      });
      if (target.kind === "project_not_found") {
        throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
      }
      if (target.kind === "no_finished_run") {
        throw new ApiError(
          409,
          "PREVIEW_NOTHING_TO_REOPEN",
          "The project has no completed run to preview",
        );
      }
      if (target.kind === "preview_active") {
        throw new ApiError(
          409,
          "PREVIEW_ALREADY_ACTIVE",
          "The project's preview is still live",
          { expiresAt: target.expiresAt.toISOString() },
        );
      }
      await options.queue.enqueue({
        projectId: request.params.id,
        workspaceId: target.workspaceId,
        runId: target.runId,
      });
      return reply.code(202).send({ status: "REQUESTED", runId: target.runId });
    },
  );
}

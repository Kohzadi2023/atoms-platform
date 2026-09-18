import { WorkspaceAdminOverviewResponseSchema } from "@atoms/contracts";
import type { FastifyInstance } from "fastify";
import { type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { WorkspaceAdminOverviewCountsLoader } from "./admin-overview-service.js";
import { loadWorkspaceAdminOverview } from "./admin-overview-service.js";
import { ApiError } from "./errors.js";
import type { ControlRepository } from "./repository.js";

const WorkspaceIdParamsSchema = z.object({ workspaceId: z.string().uuid() }).strict();

export interface AdminRoutesOptions {
  readonly repository: Pick<ControlRepository, "getWorkspaceMembership">;
  readonly loadCounts: WorkspaceAdminOverviewCountsLoader;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  options: AdminRoutesOptions,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/v1/workspaces/:workspaceId/admin/overview",
    {
      schema: {
        operationId: "getWorkspaceAdminOverview",
        params: WorkspaceIdParamsSchema,
        response: { 200: WorkspaceAdminOverviewResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const overview = await loadWorkspaceAdminOverview(
        options.repository,
        options.loadCounts,
        principal.userId,
        request.params.workspaceId,
      );
      return reply.code(200).send(overview);
    },
  );
}

import {
  WorkspaceAdminOverviewResponseSchema,
  WorkspaceAdminProjectsResponseSchema,
} from "@atoms/contracts";
import type { FastifyInstance } from "fastify";
import { type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { WorkspaceAdminOverviewCountsLoader } from "./admin-overview-service.js";
import { loadWorkspaceAdminOverview } from "./admin-overview-service.js";
import type { WorkspaceAdminProjectsLoader } from "./admin-projects-service.js";
import { loadWorkspaceAdminProjects } from "./admin-projects-service.js";
import { ApiError } from "./errors.js";
import type { ControlRepository } from "./repository.js";

const WorkspaceIdParamsSchema = z.object({ workspaceId: z.string().uuid() }).strict();

export interface AdminRoutesOptions {
  readonly repository: Pick<ControlRepository, "getWorkspaceMembership">;
  readonly loadCounts: WorkspaceAdminOverviewCountsLoader;
  readonly loadProjects: WorkspaceAdminProjectsLoader;
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

  api.get(
    "/v1/workspaces/:workspaceId/admin/projects",
    {
      schema: {
        operationId: "getWorkspaceAdminProjects",
        params: WorkspaceIdParamsSchema,
        response: { 200: WorkspaceAdminProjectsResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const projects = await loadWorkspaceAdminProjects(
        options.repository,
        options.loadProjects,
        principal.userId,
        request.params.workspaceId,
      );
      return reply.code(200).send(projects);
    },
  );
}

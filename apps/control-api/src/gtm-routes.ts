import {
  CreateDealInputSchema,
  CreateGtmScopeInputSchema,
  CreateProspectInputSchema,
  DealListResponseSchema,
  DealResponseSchema,
  GtmScopeListResponseSchema,
  GtmScopeResponseSchema,
  ProspectListResponseSchema,
  ProspectResponseSchema,
  UpdateDealStageInputSchema,
} from "@atoms/contracts";
import type { FastifyInstance } from "fastify";
import { type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import {
  toDealResponse,
  toGtmScopeResponse,
  toProspectResponse,
} from "./gtm-domain.js";
import type { GtmControlRepository } from "./gtm-repository.js";
import { ApiError, RepositoryConflictError } from "./errors.js";
import {
  requireAdministrativeRole,
  workspaceAccessDeniedError,
} from "./authorization.js";

const WorkspaceIdParamsSchema = z
  .object({ workspaceId: z.string().uuid() })
  .strict();
const GtmScopeIdParamsSchema = z
  .object({ gtmScopeId: z.string().uuid() })
  .strict();
const ProspectParamsSchema = z
  .object({ gtmScopeId: z.string().uuid(), prospectId: z.string().uuid() })
  .strict();
const DealParamsSchema = z
  .object({ gtmScopeId: z.string().uuid(), dealId: z.string().uuid() })
  .strict();

export interface GtmRoutesOptions {
  readonly repository: GtmControlRepository;
  readonly now?: () => Date;
}

export function registerGtmRoutes(
  app: FastifyInstance,
  options: GtmRoutesOptions,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const now = options.now ?? (() => new Date());

  api.post(
    "/v1/workspaces/:workspaceId/gtm-scopes",
    {
      schema: {
        operationId: "createGtmScope",
        params: WorkspaceIdParamsSchema,
        body: CreateGtmScopeInputSchema,
        response: { 201: GtmScopeResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const membership = await options.repository.getWorkspaceMembership(
        principal.userId,
        request.params.workspaceId,
      );
      if (membership === null) {
        throw workspaceAccessDeniedError(request.params.workspaceId);
      }
      requireAdministrativeRole(membership.role, "create_gtm_scope");

      try {
        const result = await options.repository.createGtmScope(
          request.params.workspaceId,
          request.body,
        );
        if (result.kind === "project_not_found") {
          throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
        }
        return reply.code(201).send(toGtmScopeResponse(result.scope));
      } catch (error) {
        if (error instanceof RepositoryConflictError) {
          throw new ApiError(409, "GTM_SCOPE_CONFLICT", error.message, {
            constraint: error.constraint,
          });
        }
        throw error;
      }
    },
  );

  api.get(
    "/v1/workspaces/:workspaceId/gtm-scopes",
    {
      schema: {
        operationId: "listGtmScopes",
        params: WorkspaceIdParamsSchema,
        response: { 200: GtmScopeListResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const membership = await options.repository.getWorkspaceMembership(
        principal.userId,
        request.params.workspaceId,
      );
      if (membership === null) {
        throw workspaceAccessDeniedError(request.params.workspaceId);
      }

      const scopes = await options.repository.listGtmScopes(request.params.workspaceId);
      return reply.code(200).send({ items: scopes.map(toGtmScopeResponse) });
    },
  );

  api.get(
    "/v1/gtm-scopes/:gtmScopeId",
    {
      schema: {
        operationId: "getGtmScope",
        params: GtmScopeIdParamsSchema,
        response: { 200: GtmScopeResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const access = await options.repository.getGtmScopeAccess(
        principal.userId,
        request.params.gtmScopeId,
      );
      if (access === null) {
        throw workspaceAccessDeniedError();
      }
      return reply.code(200).send(toGtmScopeResponse(access.scope));
    },
  );

  api.post(
    "/v1/gtm-scopes/:gtmScopeId/prospects",
    {
      schema: {
        operationId: "createProspect",
        params: GtmScopeIdParamsSchema,
        body: CreateProspectInputSchema,
        response: { 201: ProspectResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const access = await options.repository.getGtmScopeAccess(
        principal.userId,
        request.params.gtmScopeId,
      );
      if (access === null) {
        throw workspaceAccessDeniedError();
      }

      try {
        const prospect = await options.repository.createProspect(
          request.params.gtmScopeId,
          request.body,
        );
        return reply.code(201).send(toProspectResponse(prospect));
      } catch (error) {
        if (error instanceof RepositoryConflictError) {
          throw new ApiError(409, "PROSPECT_EMAIL_CONFLICT", error.message, {
            constraint: error.constraint,
          });
        }
        throw error;
      }
    },
  );

  api.get(
    "/v1/gtm-scopes/:gtmScopeId/prospects",
    {
      schema: {
        operationId: "listProspects",
        params: GtmScopeIdParamsSchema,
        response: { 200: ProspectListResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const access = await options.repository.getGtmScopeAccess(
        principal.userId,
        request.params.gtmScopeId,
      );
      if (access === null) {
        throw workspaceAccessDeniedError();
      }

      const prospects = await options.repository.listProspects(
        request.params.gtmScopeId,
      );
      return reply.code(200).send({ items: prospects.map(toProspectResponse) });
    },
  );

  api.get(
    "/v1/gtm-scopes/:gtmScopeId/prospects/:prospectId",
    {
      schema: {
        operationId: "getProspect",
        params: ProspectParamsSchema,
        response: { 200: ProspectResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const access = await options.repository.getGtmScopeAccess(
        principal.userId,
        request.params.gtmScopeId,
      );
      if (access === null) {
        throw workspaceAccessDeniedError();
      }

      const prospect = await options.repository.getProspect(
        request.params.gtmScopeId,
        request.params.prospectId,
      );
      if (prospect === null) {
        throw new ApiError(404, "PROSPECT_NOT_FOUND", "Prospect not found");
      }
      return reply.code(200).send(toProspectResponse(prospect));
    },
  );

  api.post(
    "/v1/gtm-scopes/:gtmScopeId/deals",
    {
      schema: {
        operationId: "createDeal",
        params: GtmScopeIdParamsSchema,
        body: CreateDealInputSchema,
        response: { 201: DealResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const access = await options.repository.getGtmScopeAccess(
        principal.userId,
        request.params.gtmScopeId,
      );
      if (access === null) {
        throw workspaceAccessDeniedError();
      }

      const result = await options.repository.createDeal(
        request.params.gtmScopeId,
        request.body,
        now(),
      );
      if (result.kind === "prospect_not_found") {
        throw new ApiError(404, "PROSPECT_NOT_FOUND", "Prospect not found");
      }
      return reply.code(201).send(toDealResponse(result.deal));
    },
  );

  api.get(
    "/v1/gtm-scopes/:gtmScopeId/deals",
    {
      schema: {
        operationId: "listDeals",
        params: GtmScopeIdParamsSchema,
        response: { 200: DealListResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const access = await options.repository.getGtmScopeAccess(
        principal.userId,
        request.params.gtmScopeId,
      );
      if (access === null) {
        throw workspaceAccessDeniedError();
      }

      const deals = await options.repository.listDeals(request.params.gtmScopeId);
      return reply.code(200).send({ items: deals.map(toDealResponse) });
    },
  );

  api.get(
    "/v1/gtm-scopes/:gtmScopeId/deals/:dealId",
    {
      schema: {
        operationId: "getDeal",
        params: DealParamsSchema,
        response: { 200: DealResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const access = await options.repository.getGtmScopeAccess(
        principal.userId,
        request.params.gtmScopeId,
      );
      if (access === null) {
        throw workspaceAccessDeniedError();
      }

      const deal = await options.repository.getDeal(
        request.params.gtmScopeId,
        request.params.dealId,
      );
      if (deal === null) {
        throw new ApiError(404, "DEAL_NOT_FOUND", "Deal not found");
      }
      return reply.code(200).send(toDealResponse(deal));
    },
  );

  api.patch(
    "/v1/gtm-scopes/:gtmScopeId/deals/:dealId/stage",
    {
      schema: {
        operationId: "updateDealStage",
        params: DealParamsSchema,
        body: UpdateDealStageInputSchema,
        response: { 200: DealResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const access = await options.repository.getGtmScopeAccess(
        principal.userId,
        request.params.gtmScopeId,
      );
      if (access === null) {
        throw workspaceAccessDeniedError();
      }

      const result = await options.repository.updateDealStage(
        request.params.gtmScopeId,
        request.params.dealId,
        request.body.stage,
        now(),
      );
      if (result.kind === "not_found") {
        throw new ApiError(404, "DEAL_NOT_FOUND", "Deal not found");
      }
      if (result.kind === "terminal_stage") {
        throw new ApiError(
          409,
          "DEAL_STAGE_TERMINAL",
          `Deal is already ${result.deal.stage} and cannot change stage`,
        );
      }
      return reply.code(200).send(toDealResponse(result.deal));
    },
  );
}

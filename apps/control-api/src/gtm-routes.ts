import {
  CreateDealInputSchema,
  CreateGtmScopeInputSchema,
  CreateLeadScoreInputSchema,
  CreateOutreachSequenceInputSchema,
  CreateProspectInputSchema,
  CreateSuppressionEntryInputSchema,
  CrmSyncRecordListResponseSchema,
  CrmSyncRecordResponseSchema,
  DealListResponseSchema,
  DealResponseSchema,
  GtmScopeListResponseSchema,
  GtmScopeResponseSchema,
  LeadScoreListResponseSchema,
  LeadScoreResponseSchema,
  OutreachEventListResponseSchema,
  OutreachEventResponseSchema,
  OutreachSequenceListResponseSchema,
  OutreachSequenceResponseSchema,
  ProspectListResponseSchema,
  ProspectResponseSchema,
  RecordOutreachEventInputSchema,
  SuppressionEntryListResponseSchema,
  SuppressionEntryResponseSchema,
  UpdateDealStageInputSchema,
} from "@atoms/contracts";
import type { FastifyInstance } from "fastify";
import { type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import {
  toCrmSyncRecordResponse,
  toDealResponse,
  toGtmScopeResponse,
  toLeadScoreResponse,
  toOutreachEventResponse,
  toOutreachSequenceResponse,
  toProspectResponse,
  toSuppressionEntryResponse,
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
const LeadScoreParamsSchema = z
  .object({ gtmScopeId: z.string().uuid(), prospectId: z.string().uuid() })
  .strict();
const SequenceParamsSchema = z
  .object({ gtmScopeId: z.string().uuid(), sequenceId: z.string().uuid() })
  .strict();
const CrmSyncRecordParamsSchema = z
  .object({ gtmScopeId: z.string().uuid(), recordId: z.string().uuid() })
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

  api.post(
    "/v1/gtm-scopes/:gtmScopeId/prospects/:prospectId/lead-scores",
    {
      schema: {
        operationId: "createLeadScore",
        params: LeadScoreParamsSchema,
        body: CreateLeadScoreInputSchema,
        response: { 201: LeadScoreResponseSchema },
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

      const score = await options.repository.createLeadScore(
        request.params.prospectId,
        request.body,
      );
      return reply.code(201).send(toLeadScoreResponse(score));
    },
  );

  api.get(
    "/v1/gtm-scopes/:gtmScopeId/prospects/:prospectId/lead-scores",
    {
      schema: {
        operationId: "listLeadScores",
        params: LeadScoreParamsSchema,
        response: { 200: LeadScoreListResponseSchema },
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

      const scores = await options.repository.listLeadScores(
        request.params.prospectId,
      );
      return reply.code(200).send({ items: scores.map(toLeadScoreResponse) });
    },
  );

  api.post(
    "/v1/gtm-scopes/:gtmScopeId/outreach-sequences",
    {
      schema: {
        operationId: "createOutreachSequence",
        params: GtmScopeIdParamsSchema,
        body: CreateOutreachSequenceInputSchema,
        response: { 201: OutreachSequenceResponseSchema },
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

      const result = await options.repository.createOutreachSequence(
        request.params.gtmScopeId,
        request.body,
      );
      if (result.kind === "conflict") {
        throw new ApiError(
          409,
          "OUTREACH_SEQUENCE_NAME_CONFLICT",
          "An outreach sequence with this name already exists in this GTM scope",
        );
      }
      return reply.code(201).send(toOutreachSequenceResponse(result.sequence));
    },
  );

  api.get(
    "/v1/gtm-scopes/:gtmScopeId/outreach-sequences",
    {
      schema: {
        operationId: "listOutreachSequences",
        params: GtmScopeIdParamsSchema,
        response: { 200: OutreachSequenceListResponseSchema },
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

      const sequences = await options.repository.listOutreachSequences(
        request.params.gtmScopeId,
      );
      return reply
        .code(200)
        .send({ items: sequences.map(toOutreachSequenceResponse) });
    },
  );

  api.get(
    "/v1/gtm-scopes/:gtmScopeId/outreach-sequences/:sequenceId",
    {
      schema: {
        operationId: "getOutreachSequence",
        params: SequenceParamsSchema,
        response: { 200: OutreachSequenceResponseSchema },
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

      const sequence = await options.repository.getOutreachSequence(
        request.params.gtmScopeId,
        request.params.sequenceId,
      );
      if (sequence === null) {
        throw new ApiError(
          404,
          "OUTREACH_SEQUENCE_NOT_FOUND",
          "Outreach sequence not found",
        );
      }
      return reply.code(200).send(toOutreachSequenceResponse(sequence));
    },
  );

  api.post(
    "/v1/gtm-scopes/:gtmScopeId/outreach-sequences/:sequenceId/events",
    {
      schema: {
        operationId: "recordOutreachEvent",
        params: SequenceParamsSchema,
        body: RecordOutreachEventInputSchema,
        response: { 201: OutreachEventResponseSchema },
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
      const sequence = await options.repository.getOutreachSequence(
        request.params.gtmScopeId,
        request.params.sequenceId,
      );
      if (sequence === null) {
        throw new ApiError(
          404,
          "OUTREACH_SEQUENCE_NOT_FOUND",
          "Outreach sequence not found",
        );
      }

      const result = await options.repository.recordOutreachEvent(
        request.params.sequenceId,
        request.body,
      );
      if (result.kind === "prospect_not_found") {
        throw new ApiError(404, "PROSPECT_NOT_FOUND", "Prospect not found");
      }
      return reply.code(201).send(toOutreachEventResponse(result.event));
    },
  );

  api.get(
    "/v1/gtm-scopes/:gtmScopeId/outreach-sequences/:sequenceId/events",
    {
      schema: {
        operationId: "listOutreachEvents",
        params: SequenceParamsSchema,
        response: { 200: OutreachEventListResponseSchema },
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
      const sequence = await options.repository.getOutreachSequence(
        request.params.gtmScopeId,
        request.params.sequenceId,
      );
      if (sequence === null) {
        throw new ApiError(
          404,
          "OUTREACH_SEQUENCE_NOT_FOUND",
          "Outreach sequence not found",
        );
      }

      const events = await options.repository.listOutreachEvents(
        request.params.sequenceId,
      );
      return reply.code(200).send({ items: events.map(toOutreachEventResponse) });
    },
  );

  api.post(
    "/v1/gtm-scopes/:gtmScopeId/suppression-entries",
    {
      schema: {
        operationId: "createSuppressionEntry",
        params: GtmScopeIdParamsSchema,
        body: CreateSuppressionEntryInputSchema,
        response: { 201: SuppressionEntryResponseSchema },
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

      const entry = await options.repository.createSuppressionEntry(
        request.params.gtmScopeId,
        request.body,
      );
      return reply.code(201).send(toSuppressionEntryResponse(entry));
    },
  );

  api.get(
    "/v1/gtm-scopes/:gtmScopeId/suppression-entries",
    {
      schema: {
        operationId: "listSuppressionEntries",
        params: GtmScopeIdParamsSchema,
        response: { 200: SuppressionEntryListResponseSchema },
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

      const entries = await options.repository.listSuppressionEntries(
        request.params.gtmScopeId,
      );
      return reply
        .code(200)
        .send({ items: entries.map(toSuppressionEntryResponse) });
    },
  );

  api.get(
    "/v1/gtm-scopes/:gtmScopeId/crm-sync-records",
    {
      schema: {
        operationId: "listCrmSyncRecords",
        params: GtmScopeIdParamsSchema,
        response: { 200: CrmSyncRecordListResponseSchema },
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

      const records = await options.repository.listCrmSyncRecords(
        request.params.gtmScopeId,
      );
      return reply
        .code(200)
        .send({ items: records.map(toCrmSyncRecordResponse) });
    },
  );

  api.get(
    "/v1/gtm-scopes/:gtmScopeId/crm-sync-records/:recordId",
    {
      schema: {
        operationId: "getCrmSyncRecord",
        params: CrmSyncRecordParamsSchema,
        response: { 200: CrmSyncRecordResponseSchema },
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

      const record = await options.repository.getCrmSyncRecord(
        request.params.gtmScopeId,
        request.params.recordId,
      );
      if (record === null) {
        throw new ApiError(404, "CRM_SYNC_RECORD_NOT_FOUND", "CRM sync record not found");
      }
      return reply.code(200).send(toCrmSyncRecordResponse(record));
    },
  );
}

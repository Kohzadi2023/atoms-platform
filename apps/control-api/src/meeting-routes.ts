import {
  CompleteMeetingBriefActionInputSchema,
  CreateMeetingInputSchema,
  MeetingListResponseSchema,
  MeetingResponseSchema,
  buildMeetingBriefPrompt,
  validateMeetingBriefResponse,
} from "@atoms/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { workspaceAccessDeniedError } from "./authorization.js";
import { ApiError } from "./errors.js";
import { toMeetingResponse } from "./meeting-domain.js";
import type { MeetingControlRepository } from "./meeting-repository.js";

const WorkspaceIdParamsSchema = z.object({ workspaceId: z.string().uuid() }).strict();
const MeetingIdParamsSchema = z.object({ meetingId: z.string().uuid() }).strict();

export interface MeetingRoutesOptions {
  readonly repository: MeetingControlRepository;
  readonly now?: () => Date;
}

export function registerMeetingRoutes(
  app: FastifyInstance,
  options: MeetingRoutesOptions,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const now = options.now ?? (() => new Date());

  api.post(
    "/v1/workspaces/:workspaceId/meetings",
    {
      schema: {
        operationId: "createMeeting",
        params: WorkspaceIdParamsSchema,
        body: CreateMeetingInputSchema,
        response: { 201: MeetingResponseSchema },
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

      const prompt = buildMeetingBriefPrompt(request.body);
      const result = await options.repository.createMeeting(
        request.params.workspaceId,
        request.body,
        prompt,
      );
      if (result.kind === "project_not_found") {
        throw new ApiError(
          404,
          "PROJECT_NOT_FOUND",
          "Project not found in this workspace",
        );
      }
      return reply.code(201).send(toMeetingResponse(result.meeting));
    },
  );

  api.get(
    "/v1/workspaces/:workspaceId/meetings",
    {
      schema: {
        operationId: "listMeetings",
        params: WorkspaceIdParamsSchema,
        response: { 200: MeetingListResponseSchema },
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
      const meetings = await options.repository.listMeetings(request.params.workspaceId);
      return reply.code(200).send({ items: meetings.map(toMeetingResponse) });
    },
  );

  api.get(
    "/v1/meetings/:meetingId",
    {
      schema: {
        operationId: "getMeeting",
        params: MeetingIdParamsSchema,
        response: { 200: MeetingResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const access = await options.repository.getMeetingAccess(
        principal.userId,
        request.params.meetingId,
      );
      if (access === null) {
        throw new ApiError(404, "MEETING_NOT_FOUND", "Meeting not found");
      }
      return reply.code(200).send(toMeetingResponse(access.meeting));
    },
  );

  api.post(
    "/v1/meetings/:meetingId/olivia-actions/meeting-brief/complete",
    {
      schema: {
        operationId: "completeMeetingBriefAction",
        params: MeetingIdParamsSchema,
        body: CompleteMeetingBriefActionInputSchema,
        response: { 200: MeetingResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const access = await options.repository.getMeetingAccess(
        principal.userId,
        request.params.meetingId,
      );
      if (access === null) {
        throw new ApiError(404, "MEETING_NOT_FOUND", "Meeting not found");
      }

      const validation = validateMeetingBriefResponse(request.body.response);
      if (!validation.valid || validation.normalizedResponse === undefined) {
        throw new ApiError(
          400,
          "MEETING_BRIEF_INVALID",
          "Meeting Brief did not pass validation",
          {
            missingSections: [...validation.missingSections],
            violations: [...validation.violations],
          },
        );
      }

      if (access.meeting.oliviaAction.status === "COMPLETED") {
        if (access.meeting.meetingBrief === validation.normalizedResponse) {
          return reply.code(200).send(toMeetingResponse(access.meeting));
        }
        throw new ApiError(
          409,
          "MEETING_BRIEF_ALREADY_COMPLETED",
          "The Meeting Brief action is already completed and cannot be overwritten",
        );
      }

      const result = await options.repository.completeMeetingBriefAction(
        request.params.meetingId,
        validation.normalizedResponse,
        now(),
      );
      if (result.kind === "not_found") {
        throw new ApiError(404, "MEETING_NOT_FOUND", "Meeting not found");
      }
      if (
        result.kind === "already_completed" &&
        result.meeting.meetingBrief !== validation.normalizedResponse
      ) {
        throw new ApiError(
          409,
          "MEETING_BRIEF_ALREADY_COMPLETED",
          "The Meeting Brief action is already completed and cannot be overwritten",
        );
      }
      return reply.code(200).send(toMeetingResponse(result.meeting));
    },
  );
}

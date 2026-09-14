import {
  ReleaseAssessmentResponseSchema,
  TriggerReleaseAssessmentInputSchema,
} from "@atoms/contracts";
import type { FastifyInstance } from "fastify";
import { type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { toReleaseAssessmentResponse } from "./release-domain.js";
import type { ReleaseControlRepository } from "./release-repository.js";
import { ApiError } from "./errors.js";
import { workspaceAccessDeniedError } from "./authorization.js";

const ProjectParamsSchema = z.object({ id: z.string().uuid() }).strict();
const AssessmentParamsSchema = z.object({ id: z.string().uuid() }).strict();

export interface ReleaseRoutesOptions {
  readonly repository: ReleaseControlRepository;
  readonly now?: () => Date;
}

export function registerReleaseRoutes(
  app: FastifyInstance,
  options: ReleaseRoutesOptions,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const now = options.now ?? (() => new Date());

  // Observe-only: this route never accepts evidence, criteria, or an
  // attempt from the caller (TriggerReleaseAssessmentInputSchema is empty).
  // It re-gathers evidence server-side from trusted, durable records and
  // records the result -- it grants no deployment or run-completion
  // authority regardless of the outcome.
  api.post(
    "/v1/projects/:id/release-assessments",
    {
      schema: {
        operationId: "triggerReleaseAssessment",
        params: ProjectParamsSchema,
        body: TriggerReleaseAssessmentInputSchema,
        response: { 201: ReleaseAssessmentResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const membership = await options.repository.getProjectWorkspaceMembership(
        principal.userId,
        request.params.id,
      );
      if (membership === null) {
        throw workspaceAccessDeniedError();
      }

      const result = await options.repository.triggerReleaseAssessment(
        principal.userId,
        request.params.id,
        now(),
      );
      if (result.kind === "project_not_found") {
        throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
      }
      if (result.kind === "no_eligible_run") {
        throw new ApiError(
          409,
          "NO_ELIGIBLE_RUN",
          "The project has no run to assess yet",
        );
      }
      return reply.code(201).send(toReleaseAssessmentResponse(result.assessment));
    },
  );

  api.get(
    "/v1/release-assessments/:id",
    {
      schema: {
        operationId: "getReleaseAssessment",
        params: AssessmentParamsSchema,
        response: { 200: ReleaseAssessmentResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
      }
      const assessment = await options.repository.getReleaseAssessment(
        principal.userId,
        request.params.id,
      );
      if (assessment === null) {
        throw new ApiError(
          404,
          "RELEASE_ASSESSMENT_NOT_FOUND",
          "Release assessment not found",
        );
      }
      return reply.code(200).send(toReleaseAssessmentResponse(assessment));
    },
  );
}

import {
  DatabaseActionInputSchema,
  DatabaseInstanceResponseSchema,
  MigrationArtifactResponseSchema,
  ProvisionDatabaseInputSchema,
} from "@atoms/contracts";
import type { FastifyInstance } from "fastify";
import { type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import {
  toDatabaseInstanceResponse,
  toMigrationArtifactResponse,
} from "./database-domain.js";
import type { DatabaseOperationQueue } from "./database-operation-queue.js";
import type { DatabaseControlRepository } from "./database-repository.js";
import { ApiError } from "./errors.js";
import {
  requireAdministrativeRole,
  workspaceAccessDeniedError,
} from "./authorization.js";

const ProjectParamsSchema = z.object({ id: z.string().uuid() }).strict();
const DatabaseParamsSchema = z
  .object({ id: z.string().uuid(), databaseId: z.string().uuid() })
  .strict();
const IdempotencyHeadersSchema = z
  .object({
    "idempotency-key": z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[a-zA-Z0-9._-]+$/),
  })
  .passthrough();

export interface DatabaseRoutesOptions {
  readonly repository: DatabaseControlRepository;
  readonly queue: DatabaseOperationQueue;
  readonly now?: () => Date;
}

export function registerDatabaseRoutes(
  app: FastifyInstance,
  options: DatabaseRoutesOptions,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const now = options.now ?? (() => new Date());

  api.post(
    "/v1/projects/:id/databases",
    {
      schema: {
        operationId: "provisionProjectDatabase",
        params: ProjectParamsSchema,
        headers: IdempotencyHeadersSchema,
        body: ProvisionDatabaseInputSchema,
        response: { 202: DatabaseInstanceResponseSchema },
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
      requireAdministrativeRole(membership.role, "provision_database");

      const result = await options.repository.createDatabaseOperation(
        principal.userId,
        request.params.id,
        request.headers["idempotency-key"],
        request.body,
        now(),
      );
      if (result.kind === "project_not_found") {
        throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
      }
      if (result.kind === "artifact_not_found") {
        throw new ApiError(
          404,
          "MIGRATION_ARTIFACT_NOT_FOUND",
          "A validated David migration artifact was not found",
        );
      }
      if (result.kind === "destructive_approval_required") {
        throw new ApiError(
          409,
          "DESTRUCTIVE_MIGRATION_APPROVAL_REQUIRED",
          "The schema diff contains destructive changes and requires explicit approval",
        );
      }
      if (result.kind === "idempotency_conflict") {
        throw new ApiError(
          409,
          "IDEMPOTENCY_KEY_CONFLICT",
          "The idempotency key was already used for another operation",
        );
      }

      if (!result.replayed && result.database.status === "QUEUED") {
        try {
          await options.queue.enqueue({
            operationId: result.database.operationId,
            databaseInstanceId: result.database.id,
            command: "provision",
            operationVersion: result.database.operationVersion,
          });
        } catch (error) {
          await options.repository.markDatabaseOperationFailed(
            result.database.id,
            result.database.operationId,
            result.database.operationVersion,
            {
              code: "DATABASE_QUEUE_ENQUEUE_FAILED",
              message: error instanceof Error ? error.message : "Queue unavailable",
            },
            now(),
          );
          throw new ApiError(
            503,
            "DATABASE_QUEUE_UNAVAILABLE",
            "Database operation was persisted but could not be enqueued",
          );
        }
      }
      return reply.code(202).send(toDatabaseInstanceResponse(result.database));
    },
  );

  api.get(
    "/v1/projects/:id/migration-artifacts/latest",
    {
      schema: {
        operationId: "getLatestMigrationArtifact",
        params: ProjectParamsSchema,
        response: { 200: MigrationArtifactResponseSchema },
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
      requireAdministrativeRole(membership.role, "read_migration_artifact");

      const artifact = await options.repository.getLatestMigrationArtifact(
        principal.userId,
        request.params.id,
      );
      if (artifact === null) {
        throw new ApiError(
          404,
          "MIGRATION_ARTIFACT_NOT_FOUND",
          "A validated David migration artifact was not found",
        );
      }
      return reply.code(200).send(toMigrationArtifactResponse(artifact));
    },
  );

  api.get(
    "/v1/projects/:id/databases/:databaseId",
    {
      schema: {
        operationId: "getProjectDatabase",
        params: DatabaseParamsSchema,
        response: { 200: DatabaseInstanceResponseSchema },
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
      requireAdministrativeRole(membership.role, "read_database_instance");

      const database = await options.repository.getDatabaseInstance(
        principal.userId,
        request.params.id,
        request.params.databaseId,
      );
      if (database === null) {
        throw new ApiError(404, "DATABASE_NOT_FOUND", "Database not found");
      }
      return reply.code(200).send(toDatabaseInstanceResponse(database));
    },
  );

  api.post(
    "/v1/projects/:id/databases/:databaseId/actions",
    {
      schema: {
        operationId: "controlProjectDatabase",
        params: DatabaseParamsSchema,
        body: DatabaseActionInputSchema,
        response: { 202: DatabaseInstanceResponseSchema },
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
      requireAdministrativeRole(membership.role, "control_database_instance");

      const result = await options.repository.requestDatabaseAction(
        principal.userId,
        request.params.id,
        request.params.databaseId,
        request.body,
        now(),
      );
      if (result.kind === "not_found") {
        throw new ApiError(404, "DATABASE_NOT_FOUND", "Database not found");
      }
      if (result.kind === "invalid_status") {
        throw new ApiError(
          409,
          "DATABASE_ACTION_CONFLICT",
          `Database cannot be destroyed from ${result.status}`,
        );
      }
      if (result.database.status === "DELETING") {
        try {
          await options.queue.enqueue({
            operationId: result.database.operationId,
            databaseInstanceId: result.database.id,
            command: "destroy",
            operationVersion: result.database.operationVersion,
          });
        } catch (error) {
          await options.repository.markDatabaseOperationFailed(
            result.database.id,
            result.database.operationId,
            result.database.operationVersion,
            {
              code: "DATABASE_QUEUE_ENQUEUE_FAILED",
              message: error instanceof Error ? error.message : "Queue unavailable",
            },
            now(),
          );
          throw new ApiError(
            503,
            "DATABASE_QUEUE_UNAVAILABLE",
            "Database deletion was persisted but could not be enqueued",
          );
        }
      }
      return reply.code(202).send(toDatabaseInstanceResponse(result.database));
    },
  );
}

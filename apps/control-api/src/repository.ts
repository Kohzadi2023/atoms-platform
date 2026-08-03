import type {
  CreateProjectInput,
  FileContentInput,
  JsonValue,
} from "@atoms/contracts";
import { JsonValueSchema, RunEventTypeSchema } from "@atoms/contracts";
import { Prisma, type AgentRun, type PrismaClient, type RunEvent } from "@atoms/db";

import type {
  ProjectFileRecord,
  ProjectRecord,
  RunEventRecord,
  RunRecord,
  RunStatusPatch,
} from "./domain.js";
import {
  RepositoryAttachmentError,
  RepositoryConflictError,
} from "./errors.js";

export type PutProjectFileResult =
  | { readonly kind: "ok"; readonly file: ProjectFileRecord }
  | { readonly kind: "project_not_found" }
  | {
      readonly kind: "version_conflict";
      readonly actualVersion: number | null;
    };

export type CreateRunWithIdempotencyResult =
  | {
      readonly kind: "ok";
      readonly run: RunRecord;
      readonly replayed: boolean;
    }
  | { readonly kind: "project_not_found" }
  | {
      readonly kind: "idempotency_conflict";
      readonly run: RunRecord;
    };

export interface ControlRepository {
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  createRun(
    projectId: string,
    prompt: string,
    attachmentIds?: readonly string[],
  ): Promise<RunRecord | null>;
  createRunWithIdempotency(
    projectId: string,
    prompt: string,
    idempotencyKey: string,
    attachmentIds?: readonly string[],
  ): Promise<CreateRunWithIdempotencyResult>;
  getRun(runId: string): Promise<RunRecord | null>;
  transitionRun(
    runId: string,
    expectedStatus: RunRecord["status"],
    expectedControlVersion: number,
    patch: RunStatusPatch,
  ): Promise<RunRecord | null>;
  markRunFailed(
    runId: string,
    expectedControlVersion: number,
    error: JsonValue,
  ): Promise<void>;
  listRunEventsAfter(
    runId: string,
    sequence: number,
    limit: number,
  ): Promise<readonly RunEventRecord[]>;
  listProjectFiles(
    projectId: string,
  ): Promise<readonly ProjectFileRecord[] | null>;
  getProjectFile(
    projectId: string,
    filePath: string,
    version?: number,
  ): Promise<ProjectFileRecord | null>;
  putProjectFile(
    projectId: string,
    input: FileContentInput,
  ): Promise<PutProjectFileResult>;
  close(): Promise<void>;
}

export class PrismaControlRepository implements ControlRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    try {
      return await this.#prisma.project.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
        },
      });
    } catch (error) {
      if (prismaErrorCode(error) === "P2002") {
        throw new RepositoryConflictError(
          "A project with this slug already exists in the workspace",
          "projects_workspace_id_slug_key",
        );
      }
      throw error;
    }
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    return this.#prisma.project.findFirst({
      where: { id: projectId, archivedAt: null },
    });
  }

  async createRun(
    projectId: string,
    prompt: string,
    attachmentIds: readonly string[] = [],
  ): Promise<RunRecord | null> {
    const result = await this.createRunWithIdempotency(
      projectId,
      prompt,
      `legacy-${cryptoRandomKey()}`,
      attachmentIds,
    );
    if (result.kind === "project_not_found") return null;
    if (result.kind === "idempotency_conflict") return result.run;
    return result.run;
  }

  async createRunWithIdempotency(
    projectId: string,
    prompt: string,
    idempotencyKey: string,
    attachmentIds: readonly string[] = [],
  ): Promise<CreateRunWithIdempotencyResult> {
    try {
      return await this.#prisma.$transaction(async (transaction) => {
        const project = await transaction.project.findFirst({
          where: { id: projectId, archivedAt: null },
          select: { id: true, workspaceId: true },
        });
        if (project === null) {
          return { kind: "project_not_found" };
        }

        const existing = await transaction.agentRun.findFirst({
          where: { projectId: project.id, idempotencyKey },
          include: {
            attachments: {
              select: { attachmentId: true },
              orderBy: { attachmentId: "asc" },
            },
          },
        });
        if (existing !== null) {
          const existingAttachmentIds = existing.attachments.map(
            (attachment) => attachment.attachmentId,
          );
          if (
            existing.prompt !== prompt ||
            !sameAttachmentIds(existingAttachmentIds, attachmentIds)
          ) {
            return {
              kind: "idempotency_conflict",
              run: toRunRecord(existing),
            };
          }
          return { kind: "ok", run: toRunRecord(existing), replayed: true };
        }

        const attachments =
          attachmentIds.length === 0
            ? []
            : await transaction.projectAttachment.findMany({
                where: {
                  id: { in: [...attachmentIds] },
                  projectId: project.id,
                  workspaceId: project.workspaceId,
                  status: "CLEAN",
                },
              });
        const validIds = new Set(attachments.map((attachment) => attachment.id));
        const invalidIds = attachmentIds.filter((id) => !validIds.has(id));
        if (invalidIds.length > 0) {
          throw new RepositoryAttachmentError(invalidIds);
        }

        const run = await transaction.agentRun.create({
          data: {
            projectId: project.id,
            workspaceId: project.workspaceId,
            prompt,
            idempotencyKey,
          },
        });
        if (attachments.length > 0) {
          await transaction.agentRunAttachment.createMany({
            data: attachments.map((attachment) => {
              if (
                attachment.detectedContentType === null ||
                attachment.sha256 === null ||
                attachment.cleanObjectKey === null
              ) {
                throw new RepositoryAttachmentError([attachment.id]);
              }
              return {
                runId: run.id,
                attachmentId: attachment.id,
                fileName: attachment.fileName,
                contentType: attachment.detectedContentType,
                sizeBytes: attachment.sizeBytes,
                sha256: attachment.sha256,
                objectKey: attachment.cleanObjectKey,
              };
            }),
          });
        }
        return { kind: "ok", run: toRunRecord(run), replayed: false };
      });
    } catch (error) {
      if (prismaErrorCode(error) !== "P2002") {
        throw error;
      }
      const existing = await this.#prisma.agentRun.findFirst({
        where: { projectId, idempotencyKey },
        include: {
          attachments: {
            select: { attachmentId: true },
            orderBy: { attachmentId: "asc" },
          },
        },
      });
      if (existing === null) {
        throw error;
      }
      const existingAttachmentIds = existing.attachments.map(
        (attachment) => attachment.attachmentId,
      );
      if (
        existing.prompt !== prompt ||
        !sameAttachmentIds(existingAttachmentIds, attachmentIds)
      ) {
        return { kind: "idempotency_conflict", run: toRunRecord(existing) };
      }
      return { kind: "ok", run: toRunRecord(existing), replayed: true };
    }
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const run = await this.#prisma.agentRun.findUnique({ where: { id: runId } });
    return run === null ? null : toRunRecord(run);
  }

  async transitionRun(
    runId: string,
    expectedStatus: RunRecord["status"],
    expectedControlVersion: number,
    patch: RunStatusPatch,
  ): Promise<RunRecord | null> {
    return this.#prisma.$transaction(async (transaction) => {
      const update = await transaction.agentRun.updateMany({
        where: {
          id: runId,
          status: expectedStatus,
          controlVersion: expectedControlVersion,
        },
        data: {
          status: patch.status,
          controlVersion: { increment: 1 },
          ...(patch.pausedAt === undefined
            ? {}
            : { pausedAt: patch.pausedAt }),
          ...(patch.completedAt === undefined
            ? {}
            : { completedAt: patch.completedAt }),
          ...(patch.cancelledAt === undefined
            ? {}
            : { cancelledAt: patch.cancelledAt }),
          ...(patch.startedAt === undefined
            ? {}
            : { startedAt: patch.startedAt }),
          ...(patch.error === undefined
            ? {}
            : { error: toPrismaNullableJson(patch.error) }),
        },
      });
      if (update.count !== 1) {
        return null;
      }
      const run = await transaction.agentRun.findUniqueOrThrow({
        where: { id: runId },
      });
      return toRunRecord(run);
    });
  }

  async markRunFailed(
    runId: string,
    expectedControlVersion: number,
    error: JsonValue,
  ): Promise<void> {
    await this.#prisma.agentRun.updateMany({
      where: {
        id: runId,
        status: "PENDING",
        controlVersion: expectedControlVersion,
      },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        error: toPrismaNullableJson(error),
      },
    });
  }

  async listRunEventsAfter(
    runId: string,
    sequence: number,
    limit: number,
  ): Promise<readonly RunEventRecord[]> {
    const events = await this.#prisma.runEvent.findMany({
      where: { runId, sequence: { gt: sequence } },
      orderBy: { sequence: "asc" },
      take: limit,
    });
    return events.map(toRunEventRecord);
  }

  async listProjectFiles(
    projectId: string,
  ): Promise<readonly ProjectFileRecord[] | null> {
    const project = await this.#prisma.project.findFirst({
      where: { id: projectId, archivedAt: null },
      select: { id: true },
    });
    if (project === null) return null;

    return this.#prisma.projectFile.findMany({
      where: { projectId },
      orderBy: [{ filePath: "asc" }, { version: "desc" }],
      distinct: ["filePath"],
    });
  }

  getProjectFile(
    projectId: string,
    filePath: string,
    version?: number,
  ): Promise<ProjectFileRecord | null> {
    return this.#prisma.projectFile.findFirst({
      where: {
        projectId,
        filePath,
        ...(version === undefined ? {} : { version }),
      },
      orderBy: { version: "desc" },
    });
  }

  async putProjectFile(
    projectId: string,
    input: FileContentInput,
  ): Promise<PutProjectFileResult> {
    try {
      return await this.#prisma.$transaction(
        async (transaction): Promise<PutProjectFileResult> => {
          const project = await transaction.project.findFirst({
            where: { id: projectId, archivedAt: null },
            select: { id: true },
          });
          if (project === null) {
            return { kind: "project_not_found" };
          }

          const latest = await transaction.projectFile.findFirst({
            where: { projectId, filePath: input.filePath },
            orderBy: { version: "desc" },
          });
          const actualVersion = latest?.version ?? null;
          const expectedMatches =
            input.expectedVersion === 0
              ? latest === null
              : actualVersion === input.expectedVersion;
          if (!expectedMatches) {
            return { kind: "version_conflict", actualVersion };
          }

          const file = await transaction.projectFile.create({
            data: {
              projectId,
              filePath: input.filePath,
              content: input.content,
              version: (actualVersion ?? 0) + 1,
            },
          });
          return { kind: "ok", file };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (prismaErrorCode(error) === "P2002" || prismaErrorCode(error) === "P2034") {
        const latest = await this.getProjectFile(projectId, input.filePath);
        return {
          kind: "version_conflict",
          actualVersion: latest?.version ?? null,
        };
      }
      throw error;
    }
  }

  close(): Promise<void> {
    return this.#prisma.$disconnect();
  }
}

function prismaErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function toRunRecord(record: AgentRun): RunRecord {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    status: record.status,
    prompt: record.prompt,
    eventSequence: record.eventSequence,
    controlVersion: record.controlVersion,
    error: record.error === null ? null : JsonValueSchema.parse(record.error),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    pausedAt: record.pausedAt,
    completedAt: record.completedAt,
    cancelledAt: record.cancelledAt,
  };
}

function toRunEventRecord(record: RunEvent): RunEventRecord {
  return {
    runId: record.runId,
    sequence: record.sequence,
    eventType: RunEventTypeSchema.parse(record.eventType),
    payload: JsonValueSchema.parse(record.payload),
    createdAt: record.createdAt,
  };
}

function toPrismaNullableJson(
  value: JsonValue | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function sameAttachmentIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function cryptoRandomKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

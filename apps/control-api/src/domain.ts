import type {
  ArtifactCreatedEventPayloadV1,
  AgentRunStatus,
  FileContentResponse,
  JsonValue,
  ProjectFileSummary,
  ProjectResponse,
  RunArtifactResponse,
  RunEventType,
  RunResponse,
} from "@atoms/contracts";

export type { RunJob } from "@atoms/contracts";

export interface ProjectRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

export interface RunRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly status: AgentRunStatus;
  readonly prompt: string;
  readonly eventSequence: number;
  readonly controlVersion: number;
  readonly error: JsonValue | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt: Date | null;
  readonly pausedAt: Date | null;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
}

export interface RunEventRecord {
  readonly runId: string;
  readonly sequence: number;
  readonly eventType: RunEventType;
  readonly payload: JsonValue;
  readonly createdAt: Date;
}

export interface RunArtifactRecord {
  readonly sequence: number;
  readonly createdAt: Date;
  readonly payload: ArtifactCreatedEventPayloadV1;
}

export interface ProjectFileRecord {
  readonly id: string;
  readonly projectId: string;
  readonly filePath: string;
  readonly content: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RunStatusPatch {
  readonly status: AgentRunStatus;
  readonly pausedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly cancelledAt?: Date | null;
  readonly startedAt?: Date | null;
  readonly error?: JsonValue | null;
}

export function toProjectResponse(record: ProjectRecord): ProjectResponse {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    slug: record.slug,
    description: record.description,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    archivedAt: record.archivedAt?.toISOString() ?? null,
  };
}

export function toRunResponse(record: RunRecord): RunResponse {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    status: record.status,
    prompt: record.prompt,
    eventSequence: record.eventSequence,
    controlVersion: record.controlVersion,
    error: record.error,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    pausedAt: record.pausedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
  };
}

export function toFileContentResponse(
  record: ProjectFileRecord,
): FileContentResponse {
  return {
    id: record.id,
    projectId: record.projectId,
    filePath: record.filePath,
    content: record.content,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toProjectFileSummary(
  record: ProjectFileRecord,
): ProjectFileSummary {
  return {
    id: record.id,
    projectId: record.projectId,
    filePath: record.filePath,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toRunArtifactResponse(
  record: RunArtifactRecord,
): RunArtifactResponse {
  return {
    sequence: record.sequence,
    occurredAt: record.createdAt.toISOString(),
    payload: record.payload,
  };
}

import {
  DatabaseInstanceStatusSchema,
  type DatabaseInstanceResponse,
  type DatabaseInstanceStatus,
  type GeneratedDatabaseProvider,
  type JsonValue,
  type MigrationArtifactResponse,
} from "@atoms/contracts";

export interface DatabaseInstanceRecord {
  readonly id: string;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly migrationArtifactId: string;
  readonly provider: GeneratedDatabaseProvider;
  readonly externalId: string | null;
  readonly displayName: string;
  readonly databaseName: string | null;
  readonly region: string;
  readonly status: DatabaseInstanceStatus;
  readonly operationVersion: number;
  readonly attempt: number;
  readonly recoveryCount: number;
  readonly error: JsonValue | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastHeartbeatAt: Date | null;
  readonly lastSyncedAt: Date | null;
  readonly readyAt: Date | null;
  readonly deletedAt: Date | null;
}

export interface MigrationArtifactRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly schemaPath: string;
  readonly schemaHash: string;
  readonly migrationPaths: readonly string[];
  readonly seedPath: string;
  readonly destructive: boolean;
  readonly policyReport: JsonValue;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toDatabaseInstanceResponse(
  record: DatabaseInstanceRecord,
): DatabaseInstanceResponse {
  return {
    id: record.id,
    operationId: record.operationId,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    migrationArtifactId: record.migrationArtifactId,
    provider: record.provider,
    externalId: record.externalId,
    displayName: record.displayName,
    databaseName: record.databaseName,
    region: record.region,
    status: DatabaseInstanceStatusSchema.parse(record.status),
    attempt: record.attempt,
    error: record.error,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    readyAt: record.readyAt?.toISOString() ?? null,
    deletedAt: record.deletedAt?.toISOString() ?? null,
  };
}

export function toMigrationArtifactResponse(
  record: MigrationArtifactRecord,
): MigrationArtifactResponse {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    sourceRunId: record.sourceRunId,
    schemaPath: record.schemaPath,
    schemaHash: record.schemaHash,
    migrationPaths: [...record.migrationPaths],
    seedPath: record.seedPath,
    destructive: record.destructive,
    policyReport: record.policyReport,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

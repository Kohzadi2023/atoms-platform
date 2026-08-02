import type {
  DatabaseInstanceStatus,
  DatabaseOperationJob,
  JsonValue,
} from "@atoms/contracts";
import type {
  DatabaseMigrationStepReport,
  DatabaseProvisionResult,
} from "@atoms/database-provider";
import type { AgentProjectFile } from "@atoms/agents";

export interface DatabaseExecutionRecord {
  readonly id: string;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly region: string;
  readonly provider: "SUPABASE";
  readonly externalId: string | null;
  readonly connectionSecretRef: string | null;
  readonly status: DatabaseInstanceStatus;
  readonly operationVersion: number;
  readonly migrationArtifact: {
    readonly id: string;
    readonly sourceRunId: string;
    readonly schemaHash: string;
    readonly destructive: boolean;
  };
}

export type DatabaseClaimResult =
  | { readonly kind: "ready"; readonly database: DatabaseExecutionRecord }
  | { readonly kind: "missing" }
  | { readonly kind: "stale"; readonly status: string };

export interface DatabaseOperationRepository {
  claim(
    job: DatabaseOperationJob,
    now: Date,
  ): Promise<DatabaseClaimResult>;
  recordProvisioned(
    database: DatabaseExecutionRecord,
    result: DatabaseProvisionResult,
    now: Date,
  ): Promise<boolean>;
  recordHealthCheck(
    database: DatabaseExecutionRecord,
    message: string,
    now: Date,
  ): Promise<boolean>;
  startMigration(
    database: DatabaseExecutionRecord,
    now: Date,
  ): Promise<boolean>;
  listProjectFiles(projectId: string): Promise<readonly AgentProjectFile[]>;
  completeMigration(
    database: DatabaseExecutionRecord,
    reports: readonly DatabaseMigrationStepReport[],
    now: Date,
  ): Promise<boolean>;
  completeDestroy(
    database: DatabaseExecutionRecord,
    now: Date,
  ): Promise<boolean>;
  fail(
    database: DatabaseExecutionRecord,
    error: JsonValue,
    now: Date,
  ): Promise<void>;
}

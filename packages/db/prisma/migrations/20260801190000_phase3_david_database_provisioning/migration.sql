-- Phase 3: David artifacts, generated-database provisioning, secret references,
-- and forward-only migration lifecycle.

ALTER TYPE "AgentName" ADD VALUE IF NOT EXISTS 'David';

ALTER TYPE "DatabaseInstanceStatus" ADD VALUE IF NOT EXISTS 'QUEUED' BEFORE 'PROVISIONING';
ALTER TYPE "DatabaseInstanceStatus" ADD VALUE IF NOT EXISTS 'HEALTH_CHECK' AFTER 'PROVISIONING';
ALTER TYPE "DatabaseInstanceStatus" ADD VALUE IF NOT EXISTS 'MIGRATING' AFTER 'HEALTH_CHECK';
ALTER TYPE "DatabaseInstanceStatus" ADD VALUE IF NOT EXISTS 'READY' AFTER 'MIGRATING';

CREATE TYPE "IntegrationProvider" AS ENUM ('SUPABASE');
CREATE TYPE "IntegrationConnectionStatus" AS ENUM ('CONNECTED', 'REVOKED', 'ERROR');
CREATE TYPE "SecretStoreProvider" AS ENUM ('VAULT');
CREATE TYPE "SecretReferencePurpose" AS ENUM ('PROVIDER_CREDENTIAL', 'DATABASE_RUNTIME', 'DATABASE_MIGRATION');
CREATE TYPE "SecretReferenceStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');
CREATE TYPE "MigrationArtifactStatus" AS ENUM ('VALIDATED', 'SUPERSEDED');
CREATE TYPE "MigrationRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED');

ALTER TABLE "database_instances"
  ALTER COLUMN "external_id" DROP NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'QUEUED',
  ADD COLUMN "operation_id" UUID,
  ADD COLUMN "migration_artifact_id" UUID,
  ADD COLUMN "integration_connection_id" UUID,
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "error" JSONB,
  ADD COLUMN "provider_operation_metadata" JSONB,
  ADD COLUMN "last_heartbeat_at" TIMESTAMPTZ(3),
  ADD COLUMN "ready_at" TIMESTAMPTZ(3);

UPDATE "database_instances" SET "operation_id" = "id" WHERE "operation_id" IS NULL;
ALTER TABLE "database_instances" ALTER COLUMN "operation_id" SET NOT NULL;
ALTER TABLE "database_instances" ALTER COLUMN "operation_id" SET DEFAULT gen_random_uuid();

CREATE TABLE "integration_connections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "provider" "IntegrationProvider" NOT NULL,
  "status" "IntegrationConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
  "external_account_id" VARCHAR(191),
  "external_organization_id" VARCHAR(191),
  "credential_secret_ref" VARCHAR(512) NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "secret_references" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "provider" "SecretStoreProvider" NOT NULL,
  "purpose" "SecretReferencePurpose" NOT NULL,
  "status" "SecretReferenceStatus" NOT NULL DEFAULT 'ACTIVE',
  "reference" VARCHAR(512) NOT NULL,
  "expires_at" TIMESTAMPTZ(3),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  CONSTRAINT "secret_references_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "migration_artifacts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_run_id" UUID NOT NULL,
  "agent_task_id" UUID NOT NULL,
  "status" "MigrationArtifactStatus" NOT NULL DEFAULT 'VALIDATED',
  "schema_path" VARCHAR(1024) NOT NULL,
  "schema_hash" CHAR(64) NOT NULL,
  "migration_paths" JSONB NOT NULL,
  "seed_path" VARCHAR(1024) NOT NULL,
  "destructive" BOOLEAN NOT NULL DEFAULT false,
  "policy_report" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "migration_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "migration_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "database_instance_id" UUID NOT NULL,
  "migration_artifact_id" UUID NOT NULL,
  "status" "MigrationRunStatus" NOT NULL DEFAULT 'QUEUED',
  "schema_hash" CHAR(64) NOT NULL,
  "destructive" BOOLEAN NOT NULL DEFAULT false,
  "command_results" JSONB,
  "error" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "started_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  CONSTRAINT "migration_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "database_instances_operation_id_key" ON "database_instances"("operation_id");
CREATE UNIQUE INDEX "database_instances_connection_secret_ref_key" ON "database_instances"("connection_secret_ref");
CREATE UNIQUE INDEX "integration_connections_project_id_provider_key" ON "integration_connections"("project_id", "provider");
CREATE INDEX "integration_connections_workspace_id_provider_status_idx" ON "integration_connections"("workspace_id", "provider", "status");
CREATE UNIQUE INDEX "secret_references_reference_key" ON "secret_references"("reference");
CREATE INDEX "secret_references_workspace_id_status_expires_at_idx" ON "secret_references"("workspace_id", "status", "expires_at");
CREATE INDEX "secret_references_project_id_purpose_idx" ON "secret_references"("project_id", "purpose");
CREATE UNIQUE INDEX "migration_artifacts_agent_task_id_key" ON "migration_artifacts"("agent_task_id");
CREATE INDEX "migration_artifacts_project_id_status_created_at_idx" ON "migration_artifacts"("project_id", "status", "created_at");
CREATE INDEX "migration_artifacts_source_run_id_idx" ON "migration_artifacts"("source_run_id");
CREATE UNIQUE INDEX "migration_runs_database_instance_id_migration_artifact_id_key" ON "migration_runs"("database_instance_id", "migration_artifact_id");
CREATE INDEX "migration_runs_status_created_at_idx" ON "migration_runs"("status", "created_at");

ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "secret_references" ADD CONSTRAINT "secret_references_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "secret_references" ADD CONSTRAINT "secret_references_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "migration_artifacts" ADD CONSTRAINT "migration_artifacts_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "migration_artifacts" ADD CONSTRAINT "migration_artifacts_source_run_id_fkey" FOREIGN KEY ("source_run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "migration_artifacts" ADD CONSTRAINT "migration_artifacts_agent_task_id_fkey" FOREIGN KEY ("agent_task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "database_instances" ADD CONSTRAINT "database_instances_migration_artifact_id_fkey" FOREIGN KEY ("migration_artifact_id") REFERENCES "migration_artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "database_instances" ADD CONSTRAINT "database_instances_integration_connection_id_fkey" FOREIGN KEY ("integration_connection_id") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "database_instances" ADD CONSTRAINT "database_instances_connection_secret_ref_fkey" FOREIGN KEY ("connection_secret_ref") REFERENCES "secret_references"("reference") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_database_instance_id_fkey" FOREIGN KEY ("database_instance_id") REFERENCES "database_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_migration_artifact_id_fkey" FOREIGN KEY ("migration_artifact_id") REFERENCES "migration_artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

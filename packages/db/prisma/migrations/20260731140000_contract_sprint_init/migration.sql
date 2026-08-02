-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "AgentName" AS ENUM ('Mike', 'Emma', 'Bob', 'Alex');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentTaskStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BillingProvider" AS ENUM ('STRIPE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'UNPAID', 'CANCELED');

-- CreateEnum
CREATE TYPE "DatabaseProvider" AS ENUM ('SUPABASE', 'NEON', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "DatabaseInstanceStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'FAILED', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "DeploymentProvider" AS ENUM ('VERCEL', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "DeploymentEnvironment" AS ENUM ('PREVIEW', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('QUEUED', 'BUILDING', 'READY', 'ERROR', 'CANCELED');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" VARCHAR(191) NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_files" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "file_path" VARCHAR(1024) NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'PENDING',
    "prompt" TEXT NOT NULL,
    "checkpoint" JSONB,
    "error" JSONB,
    "event_sequence" INTEGER NOT NULL DEFAULT 0,
    "control_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "paused_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "last_heartbeat_at" TIMESTAMPTZ(3),

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tasks" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "agent_name" "AgentName" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "AgentTaskStatus" NOT NULL DEFAULT 'PENDING',
    "ordinal" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "input" JSONB,
    "output" JSONB,
    "error" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_events" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider" "BillingProvider" NOT NULL DEFAULT 'STRIPE',
    "provider_customer_id" VARCHAR(191) NOT NULL,
    "provider_subscription_id" VARCHAR(191) NOT NULL,
    "plan_key" VARCHAR(100) NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'INCOMPLETE',
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "current_period_start" TIMESTAMPTZ(3),
    "current_period_end" TIMESTAMPTZ(3),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_instances" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "provider" "DatabaseProvider" NOT NULL,
    "external_id" VARCHAR(191) NOT NULL,
    "idempotency_key" VARCHAR(191) NOT NULL,
    "display_name" VARCHAR(160) NOT NULL,
    "database_name" VARCHAR(160),
    "region" VARCHAR(80),
    "connection_secret_ref" VARCHAR(512),
    "status" "DatabaseInstanceStatus" NOT NULL DEFAULT 'PROVISIONING',
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "last_synced_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "database_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "provider" "DeploymentProvider" NOT NULL DEFAULT 'VERCEL',
    "external_id" VARCHAR(191) NOT NULL,
    "external_project_id" VARCHAR(191),
    "provider_team_id" VARCHAR(191),
    "idempotency_key" VARCHAR(191) NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'QUEUED',
    "url" VARCHAR(2048),
    "source_revision" VARCHAR(191),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "ready_at" TIMESTAMPTZ(3),

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_workspace_id_user_id_key" ON "memberships"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_created_at_idx" ON "projects"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspace_id_slug_key" ON "projects"("workspace_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "projects_id_workspace_id_key" ON "projects"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "project_files_project_id_file_path_created_at_idx" ON "project_files"("project_id", "file_path", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "project_files_project_id_file_path_version_key" ON "project_files"("project_id", "file_path", "version");

-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_status_created_at_idx" ON "agent_runs"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_project_id_created_at_idx" ON "agent_runs"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_tasks_run_id_status_idx" ON "agent_tasks"("run_id", "status");

-- CreateIndex
CREATE INDEX "agent_tasks_agent_name_status_idx" ON "agent_tasks"("agent_name", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tasks_run_id_ordinal_key" ON "agent_tasks"("run_id", "ordinal");

-- CreateIndex
CREATE INDEX "run_events_run_id_created_at_idx" ON "run_events"("run_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "run_events_run_id_sequence_key" ON "run_events"("run_id", "sequence");

-- CreateIndex
CREATE INDEX "subscriptions_workspace_id_status_idx" ON "subscriptions"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_provider_provider_customer_id_idx" ON "subscriptions"("provider", "provider_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_provider_provider_subscription_id_key" ON "subscriptions"("provider", "provider_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "database_instances_idempotency_key_key" ON "database_instances"("idempotency_key");

-- CreateIndex
CREATE INDEX "database_instances_workspace_id_status_idx" ON "database_instances"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "database_instances_project_id_status_idx" ON "database_instances"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "database_instances_provider_external_id_key" ON "database_instances"("provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "deployments_idempotency_key_key" ON "deployments"("idempotency_key");

-- CreateIndex
CREATE INDEX "deployments_workspace_id_environment_status_idx" ON "deployments"("workspace_id", "environment", "status");

-- CreateIndex
CREATE INDEX "deployments_project_id_created_at_idx" ON "deployments"("project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "deployments_provider_external_id_key" ON "deployments"("provider", "external_id");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_instances" ADD CONSTRAINT "database_instances_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

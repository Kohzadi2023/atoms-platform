-- CreateEnum
CREATE TYPE "SandboxProviderType" AS ENUM ('E2B');

-- CreateEnum
CREATE TYPE "SandboxSessionStatus" AS ENUM ('PROVISIONING', 'VALIDATING', 'READY', 'FAILED', 'TERMINATED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SandboxCommandName" AS ENUM ('INSTALL', 'PRISMA_VALIDATE', 'LINT', 'TYPECHECK', 'TEST', 'BUILD', 'PREVIEW_START', 'PREVIEW_HEALTH');

-- CreateEnum
CREATE TYPE "SandboxCommandStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PreviewSessionStatus" AS ENUM ('READY', 'STOPPED', 'EXPIRED', 'ERROR');

-- CreateTable
CREATE TABLE "sandbox_sessions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "provider" "SandboxProviderType" NOT NULL DEFAULT 'E2B',
    "external_id" VARCHAR(191) NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "SandboxSessionStatus" NOT NULL DEFAULT 'PROVISIONING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "error" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "terminated_at" TIMESTAMPTZ(3),

    CONSTRAINT "sandbox_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_commands" (
    "id" UUID NOT NULL,
    "sandbox_session_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "name" "SandboxCommandName" NOT NULL,
    "command" VARCHAR(32768) NOT NULL,
    "status" "SandboxCommandStatus" NOT NULL,
    "exit_code" INTEGER NOT NULL,
    "stdout" TEXT NOT NULL,
    "stderr" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_sessions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "sandbox_session_id" UUID NOT NULL,
    "status" "PreviewSessionStatus" NOT NULL DEFAULT 'READY',
    "gateway_url" VARCHAR(2048) NOT NULL,
    "process_id" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "ready_at" TIMESTAMPTZ(3) NOT NULL,
    "stopped_at" TIMESTAMPTZ(3),
    "error" JSONB,

    CONSTRAINT "preview_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_sessions_run_id_attempt_key" ON "sandbox_sessions"("run_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_sessions_provider_external_id_key" ON "sandbox_sessions"("provider", "external_id");

-- CreateIndex
CREATE INDEX "sandbox_sessions_workspace_id_status_expires_at_idx" ON "sandbox_sessions"("workspace_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "sandbox_sessions_project_id_created_at_idx" ON "sandbox_sessions"("project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_commands_sandbox_session_id_ordinal_key" ON "sandbox_commands"("sandbox_session_id", "ordinal");

-- CreateIndex
CREATE INDEX "sandbox_commands_sandbox_session_id_status_idx" ON "sandbox_commands"("sandbox_session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "preview_sessions_sandbox_session_id_key" ON "preview_sessions"("sandbox_session_id");

-- CreateIndex
CREATE INDEX "preview_sessions_workspace_id_status_expires_at_idx" ON "preview_sessions"("workspace_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "preview_sessions_project_id_created_at_idx" ON "preview_sessions"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "preview_sessions_run_id_created_at_idx" ON "preview_sessions"("run_id", "created_at");

-- AddForeignKey
ALTER TABLE "sandbox_sessions" ADD CONSTRAINT "sandbox_sessions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_sessions" ADD CONSTRAINT "sandbox_sessions_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_commands" ADD CONSTRAINT "sandbox_commands_sandbox_session_id_fkey" FOREIGN KEY ("sandbox_session_id") REFERENCES "sandbox_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_sessions" ADD CONSTRAINT "preview_sessions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_sessions" ADD CONSTRAINT "preview_sessions_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_sessions" ADD CONSTRAINT "preview_sessions_sandbox_session_id_fkey" FOREIGN KEY ("sandbox_session_id") REFERENCES "sandbox_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

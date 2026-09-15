-- Additive only: new enums and new tables for the observe-only QA & Release
-- core (@atoms/quality). No existing table, column, or enum is altered.

-- CreateEnum
CREATE TYPE "ReleaseAssessmentStatus" AS ENUM ('READY', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ReleaseAssessmentSource" AS ENUM ('WORKER', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReleaseEvidenceKind" AS ENUM ('LINT', 'TYPECHECK', 'TEST', 'BUILD', 'REGRESSION', 'E2E', 'ACCESSIBILITY', 'PERFORMANCE', 'SECURITY', 'ACCEPTANCE');

-- CreateEnum
CREATE TYPE "ReleaseEvidenceStatus" AS ENUM ('PASSED', 'FAILED', 'SKIPPED', 'ERROR');

-- CreateTable
CREATE TABLE "release_assessments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "control_version" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL,
    "source" "ReleaseAssessmentSource" NOT NULL DEFAULT 'WORKER',
    "snapshot_sha256" CHAR(64) NOT NULL,
    "status" "ReleaseAssessmentStatus" NOT NULL,
    "acceptance_task_id" UUID,
    "policy" JSONB NOT NULL,
    "checks" JSONB NOT NULL,
    "trace_to_acceptance" JSONB NOT NULL,
    "issues" JSONB NOT NULL,
    "evaluated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_evidence" (
    "id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "source_artifact_id" UUID NOT NULL,
    "kind" "ReleaseEvidenceKind" NOT NULL,
    "status" "ReleaseEvidenceStatus" NOT NULL,
    "completed_at" TIMESTAMPTZ(3) NOT NULL,
    "acceptance_task_id" UUID,
    "acceptance_task_attempt" INTEGER,
    "criterion_ids" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "release_assessments_run_id_control_version_attempt_source_key" ON "release_assessments"("run_id", "control_version", "attempt", "source");

-- CreateIndex
CREATE INDEX "release_assessments_workspace_id_project_id_created_at_idx" ON "release_assessments"("workspace_id", "project_id", "created_at");

-- CreateIndex
CREATE INDEX "release_assessments_run_id_created_at_idx" ON "release_assessments"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "release_evidence_assessment_id_idx" ON "release_evidence"("assessment_id");

-- AddForeignKey
ALTER TABLE "release_assessments" ADD CONSTRAINT "release_assessments_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_assessments" ADD CONSTRAINT "release_assessments_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_evidence" ADD CONSTRAINT "release_evidence_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "release_assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

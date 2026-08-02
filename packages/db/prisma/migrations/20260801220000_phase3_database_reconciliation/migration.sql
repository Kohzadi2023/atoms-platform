-- Phase 3 durability completion: fenced database-operation recovery, provider
-- inventory reconciliation, and approval-gated orphan cleanup audit records.

CREATE TYPE "DatabaseReconciliationSweepStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "DatabaseReconciliationFindingKind" AS ENUM ('PROVIDER_RESOURCE_MISSING', 'ORPHAN_PROVIDER_RESOURCE', 'RECOVERY_EXHAUSTED');
CREATE TYPE "DatabaseReconciliationFindingStatus" AS ENUM ('OPEN', 'APPROVED', 'CLEANING', 'RESOLVED', 'IGNORED');

ALTER TABLE "database_instances"
  ADD COLUMN "operation_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "recovery_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_reconciled_at" TIMESTAMPTZ(3);

CREATE TABLE "database_reconciliation_sweeps" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider" "DatabaseProvider" NOT NULL,
  "status" "DatabaseReconciliationSweepStatus" NOT NULL DEFAULT 'RUNNING',
  "dry_run" BOOLEAN NOT NULL DEFAULT true,
  "stale_before" TIMESTAMPTZ(3) NOT NULL,
  "orphan_grace_before" TIMESTAMPTZ(3) NOT NULL,
  "summary" JSONB,
  "error" JSONB,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(3),
  CONSTRAINT "database_reconciliation_sweeps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "database_reconciliation_findings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "fingerprint" CHAR(64) NOT NULL,
  "sweep_id" UUID NOT NULL,
  "provider" "DatabaseProvider" NOT NULL,
  "kind" "DatabaseReconciliationFindingKind" NOT NULL,
  "status" "DatabaseReconciliationFindingStatus" NOT NULL DEFAULT 'OPEN',
  "database_instance_id" UUID,
  "external_id" VARCHAR(191),
  "resource_name" VARCHAR(160),
  "details" JSONB NOT NULL,
  "observation_count" INTEGER NOT NULL DEFAULT 1,
  "first_seen_at" TIMESTAMPTZ(3) NOT NULL,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
  "cleanup_after" TIMESTAMPTZ(3),
  "approved_by" VARCHAR(191),
  "approved_at" TIMESTAMPTZ(3),
  "resolved_at" TIMESTAMPTZ(3),
  "resolution" VARCHAR(100),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "database_reconciliation_findings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "database_instances_status_last_heartbeat_at_idx" ON "database_instances"("status", "last_heartbeat_at");
CREATE INDEX "database_reconciliation_sweeps_provider_status_started_at_idx" ON "database_reconciliation_sweeps"("provider", "status", "started_at");
CREATE UNIQUE INDEX "database_reconciliation_one_running_provider_idx" ON "database_reconciliation_sweeps"("provider") WHERE "status" = 'RUNNING';
CREATE UNIQUE INDEX "database_reconciliation_findings_fingerprint_key" ON "database_reconciliation_findings"("fingerprint");
CREATE INDEX "database_reconciliation_findings_provider_kind_status_cleanup_after_idx" ON "database_reconciliation_findings"("provider", "kind", "status", "cleanup_after");
CREATE INDEX "database_reconciliation_findings_database_instance_id_status_idx" ON "database_reconciliation_findings"("database_instance_id", "status");
CREATE INDEX "database_reconciliation_findings_sweep_id_idx" ON "database_reconciliation_findings"("sweep_id");

ALTER TABLE "database_reconciliation_findings" ADD CONSTRAINT "database_reconciliation_findings_sweep_id_fkey" FOREIGN KEY ("sweep_id") REFERENCES "database_reconciliation_sweeps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "database_reconciliation_findings" ADD CONSTRAINT "database_reconciliation_findings_database_instance_id_fkey" FOREIGN KEY ("database_instance_id") REFERENCES "database_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

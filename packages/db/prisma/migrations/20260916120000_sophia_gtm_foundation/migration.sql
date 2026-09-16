-- Revenue & GTM data foundation for Sophia. Additive only: no existing
-- table, column, or enum value is altered or removed. Deliberately does not
-- touch IntegrationProvider (created in
-- 20260801190000_phase3_david_database_provisioning) -- CrmSyncRecord gets
-- its own CrmSyncProvider enum instead, so this migration has no dependency
-- on that earlier migration's objects.

-- CreateEnum
CREATE TYPE "GtmMode" AS ENUM ('PLATFORM_GTM', 'PROJECT_GTM');

-- CreateEnum
CREATE TYPE "EvidenceStatus" AS ENUM ('EVIDENCED', 'ASSUMPTION', 'RESEARCH_REQUIRED');

-- CreateEnum
CREATE TYPE "ProspectSource" AS ENUM ('APOLLO', 'MANUAL');

-- CreateEnum
CREATE TYPE "ProspectStatus" AS ENUM ('DISCOVERED', 'ENRICHED', 'QUALIFIED', 'OUTREACH_READY', 'IN_SEQUENCE', 'CUSTOMER', 'DISQUALIFIED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "LeadScoreBand" AS ENUM ('COLD', 'WARM', 'HOT');

-- CreateEnum
CREATE TYPE "OutreachSequenceStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OutreachChannel" AS ENUM ('EMAIL', 'LINKEDIN', 'CALL');

-- CreateEnum
CREATE TYPE "OutreachEventKind" AS ENUM ('QUEUED', 'SENT', 'OPENED', 'CLICKED', 'REPLIED', 'BOUNCED', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "SuppressionChannel" AS ENUM ('EMAIL', 'LINKEDIN', 'ALL');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBED', 'BOUNCED', 'COMPLAINT', 'MANUAL', 'LEGAL_HOLD');

-- CreateEnum
CREATE TYPE "CrmSyncProvider" AS ENUM ('HUBSPOT');

-- CreateEnum
CREATE TYPE "CrmEntityType" AS ENUM ('CONTACT', 'COMPANY', 'DEAL');

-- CreateEnum
CREATE TYPE "CrmSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'CONFLICT');

-- CreateEnum
CREATE TYPE "DealStage" AS ENUM ('PROSPECTING', 'QUALIFICATION', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST');

-- CreateTable
CREATE TABLE "gtm_scopes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "mode" "GtmMode" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "gtm_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospects" (
    "id" UUID NOT NULL,
    "gtm_scope_id" UUID NOT NULL,
    "company_name" VARCHAR(160) NOT NULL,
    "company_domain" VARCHAR(255),
    "contact_name" VARCHAR(160) NOT NULL,
    "contact_email" VARCHAR(320) NOT NULL,
    "normalized_email" VARCHAR(320) NOT NULL,
    "contact_title" VARCHAR(160),
    "industry" VARCHAR(160),
    "company_size_headcount" INTEGER,
    "use_case" TEXT NOT NULL,
    "fit_evidence_status" "EvidenceStatus" NOT NULL,
    "fit_evidence_notes" TEXT,
    "source" "ProspectSource" NOT NULL,
    "source_external_id" VARCHAR(191),
    "status" "ProspectStatus" NOT NULL DEFAULT 'DISCOVERED',
    "current_score" INTEGER,
    "current_score_band" "LeadScoreBand",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "prospects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_scores" (
    "id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "band" "LeadScoreBand" NOT NULL,
    "scoring_version" VARCHAR(20) NOT NULL,
    "rationale" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_sequences" (
    "id" UUID NOT NULL,
    "gtm_scope_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" "OutreachSequenceStatus" NOT NULL DEFAULT 'DRAFT',
    "steps" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outreach_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_events" (
    "id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "step_ordinal" INTEGER NOT NULL,
    "channel" "OutreachChannel" NOT NULL,
    "kind" "OutreachEventKind" NOT NULL,
    "provider_message_id" VARCHAR(191),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppression_entries" (
    "id" UUID NOT NULL,
    "gtm_scope_id" UUID NOT NULL,
    "channel" "SuppressionChannel" NOT NULL,
    "normalized_identifier" VARCHAR(320) NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_sync_records" (
    "id" UUID NOT NULL,
    "gtm_scope_id" UUID NOT NULL,
    "provider" "CrmSyncProvider" NOT NULL,
    "entity_type" "CrmEntityType" NOT NULL,
    "prospect_id" UUID,
    "deal_id" UUID,
    "external_id" VARCHAR(191),
    "status" "CrmSyncStatus" NOT NULL DEFAULT 'PENDING',
    "last_synced_at" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "error" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "crm_sync_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" UUID NOT NULL,
    "gtm_scope_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "stage" "DealStage" NOT NULL DEFAULT 'PROSPECTING',
    "amount_usd_micros" BIGINT,
    "close_date_expected" DATE,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gtm_scopes_workspace_id_idx" ON "gtm_scopes"("workspace_id");

-- CreateIndex
CREATE INDEX "gtm_scopes_project_id_idx" ON "gtm_scopes"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "prospects_gtm_scope_id_normalized_email_key" ON "prospects"("gtm_scope_id", "normalized_email");

-- CreateIndex
CREATE UNIQUE INDEX "prospects_gtm_scope_id_source_source_external_id_key" ON "prospects"("gtm_scope_id", "source", "source_external_id");

-- CreateIndex
CREATE INDEX "prospects_gtm_scope_id_status_idx" ON "prospects"("gtm_scope_id", "status");

-- CreateIndex
CREATE INDEX "lead_scores_prospect_id_computed_at_idx" ON "lead_scores"("prospect_id", "computed_at");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_sequences_gtm_scope_id_name_key" ON "outreach_sequences"("gtm_scope_id", "name");

-- CreateIndex
CREATE INDEX "outreach_sequences_gtm_scope_id_status_idx" ON "outreach_sequences"("gtm_scope_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_events_sequence_id_prospect_id_step_ordinal_key" ON "outreach_events"("sequence_id", "prospect_id", "step_ordinal");

-- CreateIndex
CREATE INDEX "outreach_events_prospect_id_kind_idx" ON "outreach_events"("prospect_id", "kind");

-- CreateIndex
CREATE INDEX "outreach_events_sequence_id_occurred_at_idx" ON "outreach_events"("sequence_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "suppression_entries_gtm_scope_id_channel_normalized_identi_key" ON "suppression_entries"("gtm_scope_id", "channel", "normalized_identifier");

-- CreateIndex
CREATE INDEX "crm_sync_records_gtm_scope_id_status_idx" ON "crm_sync_records"("gtm_scope_id", "status");

-- CreateIndex
CREATE INDEX "deals_gtm_scope_id_stage_idx" ON "deals"("gtm_scope_id", "stage");

-- CreateIndex
CREATE INDEX "deals_prospect_id_idx" ON "deals"("prospect_id");

-- AddForeignKey
ALTER TABLE "gtm_scopes" ADD CONSTRAINT "gtm_scopes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gtm_scopes" ADD CONSTRAINT "gtm_scopes_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_gtm_scope_id_fkey" FOREIGN KEY ("gtm_scope_id") REFERENCES "gtm_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "prospects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_sequences" ADD CONSTRAINT "outreach_sequences_gtm_scope_id_fkey" FOREIGN KEY ("gtm_scope_id") REFERENCES "gtm_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "outreach_sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "prospects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_gtm_scope_id_fkey" FOREIGN KEY ("gtm_scope_id") REFERENCES "gtm_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_sync_records" ADD CONSTRAINT "crm_sync_records_gtm_scope_id_fkey" FOREIGN KEY ("gtm_scope_id") REFERENCES "gtm_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_sync_records" ADD CONSTRAINT "crm_sync_records_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_gtm_scope_id_fkey" FOREIGN KEY ("gtm_scope_id") REFERENCES "gtm_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "prospects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-added constraints (Prisma cannot express these natively; same
-- technique as packages/db/prisma/migrations/20260802070000_secure_project_attachments
-- and .../20260910153000_provider_budget_ledger).

-- GtmScope: project_id is required iff mode = PROJECT_GTM.
ALTER TABLE "gtm_scopes" ADD CONSTRAINT "gtm_scopes_project_required_check" CHECK (
  ("mode" = 'PROJECT_GTM' AND "project_id" IS NOT NULL) OR
  ("mode" = 'PLATFORM_GTM' AND "project_id" IS NULL)
);

-- GtmScope: two different per-mode uniqueness rules, expressed as partial
-- unique indexes since a single @@unique cannot be conditional.
CREATE UNIQUE INDEX "gtm_scopes_workspace_platform_key"
  ON "gtm_scopes"("workspace_id") WHERE "mode" = 'PLATFORM_GTM';
CREATE UNIQUE INDEX "gtm_scopes_project_key"
  ON "gtm_scopes"("project_id") WHERE "mode" = 'PROJECT_GTM';

-- CrmSyncRecord: exactly one of prospect_id/deal_id, matching entity_type.
ALTER TABLE "crm_sync_records" ADD CONSTRAINT "crm_sync_records_target_check" CHECK (
  ("entity_type" = 'DEAL' AND "deal_id" IS NOT NULL AND "prospect_id" IS NULL) OR
  ("entity_type" <> 'DEAL' AND "prospect_id" IS NOT NULL AND "deal_id" IS NULL)
);

-- CrmSyncRecord: per-type uniqueness, expressed as partial unique indexes.
CREATE UNIQUE INDEX "crm_sync_records_prospect_provider_key"
  ON "crm_sync_records"("provider", "prospect_id") WHERE "entity_type" <> 'DEAL';
CREATE UNIQUE INDEX "crm_sync_records_deal_provider_key"
  ON "crm_sync_records"("provider", "deal_id") WHERE "entity_type" = 'DEAL';

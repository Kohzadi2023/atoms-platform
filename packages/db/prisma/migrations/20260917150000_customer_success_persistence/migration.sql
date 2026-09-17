-- Customer Success persistence (data model only). Mirrors the CustomerSuccess
-- agent's CUSTOMER_SUCCESS_PACKAGE output shape (packages/agents/src/manifests.ts)
-- so a future increment has somewhere durable to write that output once
-- CustomerSuccess is wired into apps/orchestrator-worker/src/graph.ts.
-- No route or agent-execution wiring is added by this migration.

-- CreateEnum
CREATE TYPE "CustomerAccountStatus" AS ENUM ('ONBOARDING', 'ACTIVATING', 'ACTIVE', 'AT_RISK', 'RENEWAL_DUE', 'RENEWED', 'CHURNED', 'EXPANDED');

-- CreateEnum
CREATE TYPE "MilestoneOwner" AS ENUM ('CUSTOMER', 'CUSTOMER_SUCCESS', 'SHARED');

-- CreateEnum
CREATE TYPE "OnboardingMilestoneStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "HealthSeverity" AS ENUM ('HEALTHY', 'AT_RISK', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ChurnRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "RetentionProposalType" AS ENUM ('RENEWAL', 'EXPANSION', 'WIN_BACK');

-- CreateEnum
CREATE TYPE "RetentionApprovalReason" AS ENUM ('DISCOUNT', 'CONTRACT_CHANGE', 'BILLING_CHANGE', 'EXTERNAL_COMMUNICATION', 'ACCOUNT_CHANGE');

-- CreateEnum
CREATE TYPE "RetentionProposalStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "customer_accounts" (
    "id" UUID NOT NULL,
    "gtm_scope_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "handoff_id" UUID NOT NULL,
    "status" "CustomerAccountStatus" NOT NULL DEFAULT 'ONBOARDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_milestones" (
    "id" UUID NOT NULL,
    "customer_account_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT NOT NULL,
    "owner" "MilestoneOwner" NOT NULL,
    "status" "OnboardingMilestoneStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "target_date" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "onboarding_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activation_milestones" (
    "id" UUID NOT NULL,
    "customer_account_id" UUID NOT NULL,
    "milestone_name" VARCHAR(160) NOT NULL,
    "definition_of_first_value" TEXT NOT NULL,
    "achieved" BOOLEAN NOT NULL DEFAULT false,
    "achieved_at" TIMESTAMPTZ(3),
    "evidence_status" "EvidenceStatus" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "activation_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_signals" (
    "id" UUID NOT NULL,
    "customer_account_id" UUID NOT NULL,
    "signal" VARCHAR(160) NOT NULL,
    "severity" "HealthSeverity" NOT NULL,
    "observed_evidence" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "churn_risk_assessments" (
    "id" UUID NOT NULL,
    "customer_account_id" UUID NOT NULL,
    "risk_level" "ChurnRiskLevel" NOT NULL,
    "primary_drivers" JSONB NOT NULL,
    "mitigation_plan" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "churn_risk_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_proposals" (
    "id" UUID NOT NULL,
    "customer_account_id" UUID NOT NULL,
    "type" "RetentionProposalType" NOT NULL,
    "rationale" TEXT NOT NULL,
    "proposed_action" TEXT NOT NULL,
    "approval_reason" "RetentionApprovalReason" NOT NULL,
    "status" "RetentionProposalStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "retention_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_deal_id_key" ON "customer_accounts"("deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_handoff_id_key" ON "customer_accounts"("handoff_id");

-- CreateIndex
CREATE INDEX "customer_accounts_gtm_scope_id_status_idx" ON "customer_accounts"("gtm_scope_id", "status");

-- CreateIndex
CREATE INDEX "onboarding_milestones_customer_account_id_status_idx" ON "onboarding_milestones"("customer_account_id", "status");

-- CreateIndex
CREATE INDEX "activation_milestones_customer_account_id_achieved_idx" ON "activation_milestones"("customer_account_id", "achieved");

-- CreateIndex
CREATE INDEX "health_signals_customer_account_id_severity_created_at_idx" ON "health_signals"("customer_account_id", "severity", "created_at");

-- CreateIndex
CREATE INDEX "churn_risk_assessments_customer_account_id_created_at_idx" ON "churn_risk_assessments"("customer_account_id", "created_at");

-- CreateIndex
CREATE INDEX "retention_proposals_customer_account_id_status_idx" ON "retention_proposals"("customer_account_id", "status");

-- AddForeignKey
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_gtm_scope_id_fkey" FOREIGN KEY ("gtm_scope_id") REFERENCES "gtm_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "prospects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_handoff_id_fkey" FOREIGN KEY ("handoff_id") REFERENCES "customer_success_handoffs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_milestones" ADD CONSTRAINT "onboarding_milestones_customer_account_id_fkey" FOREIGN KEY ("customer_account_id") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activation_milestones" ADD CONSTRAINT "activation_milestones_customer_account_id_fkey" FOREIGN KEY ("customer_account_id") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_signals" ADD CONSTRAINT "health_signals_customer_account_id_fkey" FOREIGN KEY ("customer_account_id") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "churn_risk_assessments" ADD CONSTRAINT "churn_risk_assessments_customer_account_id_fkey" FOREIGN KEY ("customer_account_id") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_proposals" ADD CONSTRAINT "retention_proposals_customer_account_id_fkey" FOREIGN KEY ("customer_account_id") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

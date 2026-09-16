-- Durable, auditable record that a Deal reached CLOSED_WON and is ready for
-- a CustomerSuccess handoff. Additive only; detection only -- no agent
-- execution or AgentRun creation happens as a result of this table.

-- CreateTable
CREATE TABLE "customer_success_handoffs" (
    "id" UUID NOT NULL,
    "gtm_scope_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "detected_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_success_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_success_handoffs_deal_id_key" ON "customer_success_handoffs"("deal_id");

-- CreateIndex
CREATE INDEX "customer_success_handoffs_gtm_scope_id_created_at_idx" ON "customer_success_handoffs"("gtm_scope_id", "created_at");

-- AddForeignKey
ALTER TABLE "customer_success_handoffs" ADD CONSTRAINT "customer_success_handoffs_gtm_scope_id_fkey" FOREIGN KEY ("gtm_scope_id") REFERENCES "gtm_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_success_handoffs" ADD CONSTRAINT "customer_success_handoffs_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_success_handoffs" ADD CONSTRAINT "customer_success_handoffs_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "prospects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

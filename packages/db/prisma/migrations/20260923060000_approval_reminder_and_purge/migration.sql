-- G2 (docs/adr/production-execution-gate.md), issue #100: the remaining P1
-- pieces of approval expiry -- a reminder record and a data-retention purge
-- for expired paused runs. No new AgentRunStatus: an expired run stays
-- CANCELLED with error.code APPROVAL_EXPIRED, exactly as #114 shipped.
-- Purely additive and nullable; both new sweeps are off until an operator
-- sets a positive PAUSED_RUN_REMINDER_HOURS / PAUSED_RUN_DATA_PURGE_AFTER_DAYS.

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN "reminder_sent_at" TIMESTAMPTZ(3);
ALTER TABLE "agent_runs" ADD COLUMN "purged_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "agent_runs_status_paused_at_idx" ON "agent_runs"("status", "paused_at");
CREATE INDEX "agent_runs_status_cancelled_at_idx" ON "agent_runs"("status", "cancelled_at");

-- Actual provider usage per run, recorded after each call completes. The
-- reservation ledger (reserved_usd_micros) stays the enforcement value; this
-- column exists so cost per outcome can be reported without changing what is
-- enforced.
ALTER TABLE "atoms_runtime"."run_provider_budgets"
    ADD COLUMN "actual_usd_micros" INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT "run_provider_budgets_actual_nonnegative" CHECK ("actual_usd_micros" >= 0);

-- Per-workspace, per-UTC-day ceiling on reserved provider spend. Enforced in
-- the same transaction as the per-run reservation, so a workspace cannot start
-- many individually valid runs whose total exceeds its daily allowance.
CREATE TABLE "atoms_runtime"."workspace_provider_budget_windows" (
    "workspace_id" UUID NOT NULL,
    "window_date" DATE NOT NULL,
    "reserved_usd_micros" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_provider_budget_windows_pkey" PRIMARY KEY ("workspace_id", "window_date"),
    CONSTRAINT "workspace_provider_budget_windows_reserved_nonnegative" CHECK ("reserved_usd_micros" >= 0),
    CONSTRAINT "workspace_provider_budget_windows_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

COMMENT ON TABLE "atoms_runtime"."workspace_provider_budget_windows" IS
    'Durable per-workspace daily reservation total (UTC). Counts reservations, which are conservative upper bounds, so the ceiling holds even when actual spend is lower.';

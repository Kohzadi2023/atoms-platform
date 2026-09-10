CREATE SCHEMA IF NOT EXISTS "atoms_runtime";

CREATE TABLE "atoms_runtime"."run_provider_budgets" (
    "run_id" UUID NOT NULL,
    "total_usd_micros" INTEGER NOT NULL,
    "reserved_usd_micros" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_provider_budgets_pkey" PRIMARY KEY ("run_id"),
    CONSTRAINT "run_provider_budgets_total_positive" CHECK ("total_usd_micros" > 0),
    CONSTRAINT "run_provider_budgets_reserved_nonnegative" CHECK ("reserved_usd_micros" >= 0),
    CONSTRAINT "run_provider_budgets_reserved_within_total" CHECK ("reserved_usd_micros" <= "total_usd_micros"),
    CONSTRAINT "run_provider_budgets_run_id_fkey"
        FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

COMMENT ON SCHEMA "atoms_runtime" IS
    'Operational runtime controls intentionally kept outside the Prisma application schema.';

COMMENT ON TABLE "atoms_runtime"."run_provider_budgets" IS
    'Durable per-run provider reservation ledger. The first reservation fixes total_usd_micros; later runtime configuration may only tighten the effective ceiling.';

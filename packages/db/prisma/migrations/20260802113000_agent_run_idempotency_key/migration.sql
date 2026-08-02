-- Durable idempotency for run creation commands.

ALTER TABLE "agent_runs"
  ADD COLUMN "idempotency_key" VARCHAR(191);

CREATE UNIQUE INDEX "agent_runs_project_id_idempotency_key_key"
  ON "agent_runs"("project_id", "idempotency_key");

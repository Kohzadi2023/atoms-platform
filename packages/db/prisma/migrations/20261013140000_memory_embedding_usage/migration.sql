-- Memory and retrieval, phase P0 (docs/adr/memory-and-retrieval.md): the per-workspace
-- daily embedding cap. One row per workspace per UTC day.

-- CreateTable
CREATE TABLE "memory_embedding_usage" (
    "workspace_id" UUID NOT NULL,
    "usage_date" DATE NOT NULL,
    "tokens" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memory_embedding_usage_pkey" PRIMARY KEY ("workspace_id","usage_date")
);

-- AddForeignKey
ALTER TABLE "memory_embedding_usage" ADD CONSTRAINT "memory_embedding_usage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

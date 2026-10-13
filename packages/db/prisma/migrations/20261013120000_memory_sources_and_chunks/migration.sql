-- Memory and retrieval, phase P0 (docs/adr/memory-and-retrieval.md).
--
-- Needs the pgvector extension. On Azure Database for PostgreSQL the server must
-- first allow it (the azure.extensions server parameter must include VECTOR);
-- without that this migration fails at the first statement and changes nothing.

CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "MemorySourceKind" AS ENUM ('DOCUMENT', 'CONVERSATION');

-- CreateTable
CREATE TABLE "memory_sources" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" "MemorySourceKind" NOT NULL DEFAULT 'DOCUMENT',
    "title" VARCHAR(300) NOT NULL,
    "language" VARCHAR(16),
    "content_hash" VARCHAR(64) NOT NULL,
    "contains_personal_data" BOOLEAN NOT NULL DEFAULT false,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memory_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- "search" is generated from "text" so it can never drift from it. The 'simple'
-- configuration does no stemming, which is what a mix of Persian and English needs.
CREATE TABLE "memory_chunks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL,
    "embedding_model" VARCHAR(100) NOT NULL,
    "embedding" vector(768) NOT NULL,
    "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_sources_workspace_id_created_at_idx" ON "memory_sources"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_sources_workspace_id_content_hash_key" ON "memory_sources"("workspace_id", "content_hash");

-- CreateIndex
CREATE INDEX "memory_chunks_workspace_id_idx" ON "memory_chunks"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_chunks_source_id_position_key" ON "memory_chunks"("source_id", "position");

-- Similarity search (cosine distance) and full-text search. Not expressible in the
-- Prisma schema, so they are only here.
CREATE INDEX "memory_chunks_embedding_hnsw_idx" ON "memory_chunks" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "memory_chunks_search_gin_idx" ON "memory_chunks" USING gin ("search");

-- AddForeignKey
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "memory_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

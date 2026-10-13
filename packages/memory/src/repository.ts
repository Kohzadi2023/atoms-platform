import type { PrismaClient } from "@atoms/db";

import { reciprocalRankFusion } from "./fusion.js";
import { toKeywordQuery, toVectorLiteral } from "./vector.js";

export interface IngestChunk {
  readonly position: number;
  readonly text: string;
  readonly tokenCount: number;
  readonly embedding: readonly number[];
}

export interface IngestInput {
  readonly workspaceId: string;
  readonly title: string;
  readonly kind?: "DOCUMENT" | "CONVERSATION";
  readonly language?: string;
  readonly containsPersonalData?: boolean;
  /** `contentHash(rawText)` from chunker.ts; identical text in one workspace is one source. */
  readonly contentHash: string;
  readonly embeddingModel: string;
  readonly chunks: readonly IngestChunk[];
}

export type IngestResult =
  | { readonly status: "CREATED"; readonly sourceId: string; readonly chunkCount: number }
  | { readonly status: "DUPLICATE"; readonly sourceId: string };

export interface QuickSearchInput {
  readonly workspaceId: string;
  readonly queryText: string;
  readonly queryEmbedding: readonly number[];
  /** Results returned after fusion. */
  readonly limit?: number;
  /** Candidates taken from each of the two searches before fusion. */
  readonly candidatesPerSearch?: number;
}

export interface MemoryHit {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly position: number;
  /** The passage, verbatim. A caller cites this together with the source id. */
  readonly text: string;
  readonly score: number;
  /** 1-based rank in the vector search and in the keyword search; null if absent from it. */
  readonly vectorRank: number | null;
  readonly keywordRank: number | null;
}

interface CandidateRow {
  readonly id: string;
  readonly source_id: string;
  readonly title: string;
  readonly position: number;
  readonly text: string;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_CANDIDATES = 30;
const MAX_CANDIDATES = 200;
/** pgvector's default of 40 starves a filtered HNSW scan; raised per transaction only. */
const HNSW_EF_SEARCH = 200;

/**
 * The only door to `memory_sources` and `memory_chunks`. Every method takes
 * `workspaceId` and applies it to every statement, so one workspace can never
 * read or delete another's passages. Prisma cannot read the `embedding` or
 * `search` columns, hence the SQL.
 */
export class MemoryRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    if (input.chunks.length === 0) throw new RangeError("a source needs at least one chunk");
    // Validate every vector before touching the database.
    const vectors = input.chunks.map((chunk) => toVectorLiteral(chunk.embedding));

    return this.#prisma.$transaction(async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO memory_sources
          (id, workspace_id, kind, title, language, content_hash, contains_personal_data, chunk_count, updated_at)
        VALUES
          (gen_random_uuid(), ${input.workspaceId}::uuid, ${input.kind ?? "DOCUMENT"}::"MemorySourceKind",
           ${input.title}, ${input.language ?? null}, ${input.contentHash},
           ${input.containsPersonalData ?? false}, ${input.chunks.length}, now())
        ON CONFLICT (workspace_id, content_hash) DO NOTHING
        RETURNING id::text AS id`;
      const created = inserted[0];
      if (created === undefined) {
        const existing = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM memory_sources
          WHERE workspace_id = ${input.workspaceId}::uuid AND content_hash = ${input.contentHash}`;
        const found = existing[0];
        if (found === undefined) throw new Error("memory source vanished during ingest");
        return { status: "DUPLICATE", sourceId: found.id } as const;
      }

      for (const [index, chunk] of input.chunks.entries()) {
        await tx.$executeRaw`
          INSERT INTO memory_chunks
            (id, workspace_id, source_id, position, text, token_count, embedding_model, embedding)
          VALUES
            (gen_random_uuid(), ${input.workspaceId}::uuid, ${created.id}::uuid, ${chunk.position},
             ${chunk.text}, ${chunk.tokenCount}, ${input.embeddingModel}, ${vectors[index]}::vector)`;
      }
      return { status: "CREATED", sourceId: created.id, chunkCount: input.chunks.length } as const;
    });
  }

  /** Hybrid search: cosine similarity and keyword match, merged by reciprocal rank fusion. */
  async searchQuick(input: QuickSearchInput): Promise<MemoryHit[]> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const candidates = Math.min(input.candidatesPerSearch ?? DEFAULT_CANDIDATES, MAX_CANDIDATES);
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(candidates) || candidates < 1) {
      throw new RangeError("limit and candidatesPerSearch must be positive integers");
    }
    const vector = toVectorLiteral(input.queryEmbedding);
    const keywordQuery = toKeywordQuery(input.queryText);

    const [byVector, byKeyword] = await this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('hnsw.ef_search', ${String(HNSW_EF_SEARCH)}, true)`;
      const vectorRows = await tx.$queryRaw<CandidateRow[]>`
        SELECT c.id::text AS id, c.source_id::text AS source_id, s.title, c.position, c.text
        FROM memory_chunks c
        JOIN memory_sources s ON s.id = c.source_id
        WHERE c.workspace_id = ${input.workspaceId}::uuid
        ORDER BY c.embedding <=> ${vector}::vector
        LIMIT ${candidates}`;
      const keywordRows =
        keywordQuery === null
          ? []
          : await tx.$queryRaw<CandidateRow[]>`
              SELECT c.id::text AS id, c.source_id::text AS source_id, s.title, c.position, c.text
              FROM memory_chunks c
              JOIN memory_sources s ON s.id = c.source_id
              WHERE c.workspace_id = ${input.workspaceId}::uuid
                AND c.search @@ to_tsquery('simple', ${keywordQuery})
              ORDER BY ts_rank_cd(c.search, to_tsquery('simple', ${keywordQuery})) DESC, c.id
              LIMIT ${candidates}`;
      return [vectorRows, keywordRows] as const;
    });

    const rows = new Map<string, CandidateRow>();
    for (const row of [...byVector, ...byKeyword]) rows.set(row.id, row);

    return reciprocalRankFusion([byVector, byKeyword], { limit }).map((fused) => {
      const row = rows.get(fused.id);
      if (row === undefined) throw new Error("fused hit without a row");
      return {
        chunkId: row.id,
        sourceId: row.source_id,
        sourceTitle: row.title,
        position: row.position,
        text: row.text,
        score: fused.score,
        vectorRank: fused.ranks[0] ?? null,
        keywordRank: fused.ranks[1] ?? null,
      };
    });
  }

  /** Deletes a source and, by cascade, its chunks. False if it is not this workspace's. */
  async deleteSource(workspaceId: string, sourceId: string): Promise<boolean> {
    const deleted = await this.#prisma.$executeRaw`
      DELETE FROM memory_sources WHERE id = ${sourceId}::uuid AND workspace_id = ${workspaceId}::uuid`;
    return deleted > 0;
  }
}

import { chunkText, contentHash, normalizeText } from "./chunker.js";
import { DEFAULT_DAILY_EMBEDDING_TOKEN_CAP, type EmbeddingBudget } from "./embedding-budget.js";
import type { IngestResult, MemoryRepository } from "./repository.js";

/** What ingestion needs from an embedding provider; `EmbeddingGateway` from model-gateway fits. */
export interface Embedder {
  embed(request: { readonly inputs: readonly string[] }): Promise<{
    readonly model: string;
    readonly vectors: readonly (readonly number[])[];
    readonly usage: { readonly totalTokens: number };
  }>;
}

export interface IngestDocumentInput {
  readonly workspaceId: string;
  readonly title: string;
  readonly text: string;
  readonly kind?: "DOCUMENT" | "CONVERSATION";
  readonly language?: string;
  readonly containsPersonalData?: boolean;
  readonly dailyTokenCap?: number;
}

export type IngestDocumentResult =
  | IngestResult
  /** The day's embedding cap would be passed; nothing was embedded or stored. */
  | { readonly status: "DAILY_CAP_EXCEEDED"; readonly requiredTokens: number; readonly dailyCap: number };

/** Texts per embedding request; the gateway accepts at most 100. */
const EMBED_BATCH_SIZE = 100;

export interface DocumentIngester {
  ingestDocument(input: IngestDocumentInput): Promise<IngestDocumentResult>;
}

/**
 * Turns a document into stored, searchable passages: normalise, skip it if the
 * workspace already has this exact text, chunk, reserve the day's embedding
 * tokens, embed, store. Refuses (never truncates) when the cap would be passed,
 * and gives the reservation back if the provider or the database fails.
 */
export function createDocumentIngester(deps: {
  readonly repository: MemoryRepository;
  readonly budget: EmbeddingBudget;
  readonly embedder: Embedder;
}): DocumentIngester {
  return {
    async ingestDocument(input) {
      if (normalizeText(input.text).length === 0) throw new RangeError("document has no text");
      const hash = contentHash(input.text);

      // Cheapest exit first: the same text is already stored, so spend nothing.
      const existing = await deps.repository.findSourceIdByHash(input.workspaceId, hash);
      if (existing !== null) return { status: "DUPLICATE", sourceId: existing };

      const chunks = chunkText(input.text);
      const estimated = chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
      const dailyCap = input.dailyTokenCap ?? DEFAULT_DAILY_EMBEDDING_TOKEN_CAP;
      if (!(await deps.budget.reserve(input.workspaceId, estimated, dailyCap))) {
        return { status: "DAILY_CAP_EXCEEDED", requiredTokens: estimated, dailyCap };
      }

      // What the provider has actually charged so far, and whether the reservation
      // has been corrected to it. A failure before that gives back the unspent part.
      let spent = 0;
      let settled = false;
      try {
        const vectors: (readonly number[])[] = [];
        let model: string | undefined;
        for (let start = 0; start < chunks.length; start += EMBED_BATCH_SIZE) {
          const batch = chunks.slice(start, start + EMBED_BATCH_SIZE);
          const response = await deps.embedder.embed({ inputs: batch.map((chunk) => chunk.text) });
          if (response.vectors.length !== batch.length) {
            throw new Error(`embedder returned ${response.vectors.length} vectors for ${batch.length} texts`);
          }
          if (model !== undefined && model !== response.model) {
            throw new Error("embedder changed model during one document");
          }
          model = response.model;
          vectors.push(...response.vectors);
          // Gemini's OpenAI-compatible endpoint may omit usage (seen on staging,
          // 2026-10-13). Count the estimate then, so the daily cap never sees zero.
          spent +=
            response.usage.totalTokens > 0
              ? response.usage.totalTokens
              : batch.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
        }
        if (model === undefined) throw new Error("embedder returned no model id");

        await deps.budget.adjust(input.workspaceId, spent - estimated);
        settled = true;

        return await deps.repository.ingest({
          workspaceId: input.workspaceId,
          title: input.title,
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.language === undefined ? {} : { language: input.language }),
          ...(input.containsPersonalData === undefined
            ? {}
            : { containsPersonalData: input.containsPersonalData }),
          contentHash: hash,
          embeddingModel: model,
          chunks: chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index] ?? [] })),
        });
      } catch (error) {
        // If the final insert failed the embedding was still spent, so only a failure
        // before settling gives tokens back.
        if (!settled) await deps.budget.adjust(input.workspaceId, spent - estimated);
        throw error;
      }
    },
  };
}

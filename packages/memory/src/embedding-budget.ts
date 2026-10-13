import type { PrismaClient } from "@atoms/db";

/**
 * Default per-workspace cap on tokens sent to the embedding model per UTC day.
 * Roughly 150 pages of text. A code default, not a platform limit: the caller
 * passes the real value.
 */
export const DEFAULT_DAILY_EMBEDDING_TOKEN_CAP = 500_000;

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Daily token budget for embeddings, separate from the generation budget so a
 * large upload cannot spend the model budget. A reservation is made atomically
 * before the model is called (two uploads at once cannot both slip under the
 * cap) and settled to the real usage afterwards.
 */
export class EmbeddingBudget {
  readonly #prisma: PrismaClient;
  readonly #now: () => Date;

  constructor(prisma: PrismaClient, now: () => Date = () => new Date()) {
    this.#prisma = prisma;
    this.#now = now;
  }

  /** True and the tokens are held; false and nothing changes if the day's cap would be passed. */
  async reserve(workspaceId: string, tokens: number, dailyCap: number): Promise<boolean> {
    assertTokens(tokens);
    if (tokens > dailyCap) return false;
    const day = utcDay(this.#now());
    const rows = await this.#prisma.$queryRaw<{ tokens: bigint }[]>`
      INSERT INTO memory_embedding_usage (workspace_id, usage_date, tokens, updated_at)
      VALUES (${workspaceId}::uuid, ${day}::date, ${tokens}, now())
      ON CONFLICT (workspace_id, usage_date) DO UPDATE
        SET tokens = memory_embedding_usage.tokens + EXCLUDED.tokens, updated_at = now()
        WHERE memory_embedding_usage.tokens + EXCLUDED.tokens <= ${dailyCap}
      RETURNING tokens`;
    return rows.length > 0;
  }

  /**
   * Corrects a reservation to what the provider reported: pass the difference
   * (actual minus reserved, negative to give tokens back). A failed call gives
   * back the whole reservation.
   */
  async adjust(workspaceId: string, deltaTokens: number): Promise<void> {
    if (!Number.isInteger(deltaTokens)) throw new RangeError("deltaTokens must be an integer");
    if (deltaTokens === 0) return;
    const day = utcDay(this.#now());
    await this.#prisma.$executeRaw`
      UPDATE memory_embedding_usage
      SET tokens = GREATEST(0, tokens + ${deltaTokens}), updated_at = now()
      WHERE workspace_id = ${workspaceId}::uuid AND usage_date = ${day}::date`;
  }

  async usedToday(workspaceId: string): Promise<number> {
    const day = utcDay(this.#now());
    const rows = await this.#prisma.$queryRaw<{ tokens: bigint }[]>`
      SELECT tokens FROM memory_embedding_usage
      WHERE workspace_id = ${workspaceId}::uuid AND usage_date = ${day}::date`;
    return Number(rows[0]?.tokens ?? 0n);
  }
}

function assertTokens(tokens: number): void {
  if (!Number.isInteger(tokens) || tokens < 1) throw new RangeError("tokens must be a positive integer");
}

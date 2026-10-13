export interface RankedHit {
  readonly id: string;
}

export interface FusedHit {
  readonly id: string;
  readonly score: number;
  /** 1-based rank in each input list that contained the hit, by list index. */
  readonly ranks: readonly (number | null)[];
}

/** Standard constant from the original reciprocal rank fusion paper. */
export const RRF_K = 60;

/**
 * Reciprocal rank fusion: merge several ranked lists (for example vector
 * similarity and keyword search) without having to compare their raw scores,
 * which are on different scales. A hit's score is the sum of 1 / (k + rank)
 * over the lists it appears in. Ties break on the earliest rank, then on id,
 * so the result is deterministic.
 */
export function reciprocalRankFusion(
  lists: readonly (readonly RankedHit[])[],
  options: {
    readonly k?: number;
    readonly limit?: number;
    /** One weight per list (default 1 each): a weak list can count for less. */
    readonly weights?: readonly number[];
  } = {},
): FusedHit[] {
  const k = options.k ?? RRF_K;
  if (!(k > 0)) throw new RangeError("k must be positive");
  const weights = options.weights ?? lists.map(() => 1);
  if (weights.length !== lists.length || weights.some((w) => !(w >= 0) || !Number.isFinite(w))) {
    throw new RangeError("weights must be one finite, non-negative number per list");
  }

  const byId = new Map<string, { score: number; ranks: (number | null)[] }>();
  lists.forEach((list, listIndex) => {
    const seenInList = new Set<string>();
    list.forEach((hit, index) => {
      if (seenInList.has(hit.id)) return; // a duplicate within one list counts once
      seenInList.add(hit.id);
      const rank = index + 1;
      const entry = byId.get(hit.id) ?? { score: 0, ranks: lists.map(() => null) };
      entry.score += (weights[listIndex] ?? 1) / (k + rank);
      entry.ranks[listIndex] = rank;
      byId.set(hit.id, entry);
    });
  });

  const best = (ranks: readonly (number | null)[]): number =>
    Math.min(...ranks.filter((r): r is number => r !== null));

  const fused = [...byId.entries()].map(([id, e]) => ({ id, score: e.score, ranks: e.ranks }));
  fused.sort(
    (a, b) => b.score - a.score || best(a.ranks) - best(b.ranks) || a.id.localeCompare(b.id),
  );
  return options.limit === undefined ? fused : fused.slice(0, options.limit);
}

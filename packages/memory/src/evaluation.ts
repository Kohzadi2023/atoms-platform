export interface RankedResult {
  /** Ids of the retrieved passages, best first. */
  readonly ranking: readonly string[];
  /** The one passage that answers the question. */
  readonly expected: string;
}

export interface RetrievalSummary {
  readonly questions: number;
  readonly recallAt1: number;
  readonly recallAt3: number;
  /** Mean reciprocal rank; 1 means the answer is always first, 0 means never retrieved. */
  readonly meanReciprocalRank: number;
}

/** 1-based position of the expected passage, or null if it was not retrieved. */
export function rankOf(result: RankedResult): number | null {
  const index = result.ranking.indexOf(result.expected);
  return index === -1 ? null : index + 1;
}

export function summarizeRetrieval(results: readonly RankedResult[]): RetrievalSummary {
  if (results.length === 0) {
    return { questions: 0, recallAt1: 0, recallAt3: 0, meanReciprocalRank: 0 };
  }
  let at1 = 0;
  let at3 = 0;
  let reciprocal = 0;
  for (const result of results) {
    const rank = rankOf(result);
    if (rank === null) continue;
    if (rank <= 1) at1 += 1;
    if (rank <= 3) at3 += 1;
    reciprocal += 1 / rank;
  }
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    questions: results.length,
    recallAt1: round(at1 / results.length),
    recallAt3: round(at3 / results.length),
    meanReciprocalRank: round(reciprocal / results.length),
  };
}

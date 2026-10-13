/**
 * Runs the golden set end to end against a real database and the real embedding
 * provider: ingest the passages into a throwaway workspace, ask each question, and
 * report how often the right passage comes back for the vector search, the keyword
 * search and the fused result. Prints lines starting with "QG". Deletes its workspace.
 *
 *   DATABASE_URL=... GOOGLE_API_KEY=... node packages/memory/dist/eval-cli.js
 */
import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@atoms/db";
import { GeminiModelGateway } from "@atoms/model-gateway";

import { EmbeddingBudget } from "./embedding-budget.js";
import { summarizeRetrieval, type RankedResult } from "./evaluation.js";
import { GOLDEN_PASSAGES, GOLDEN_QUESTIONS } from "./golden-set.js";
import { createDocumentIngester } from "./ingest.js";
import { MemoryRepository } from "./repository.js";

const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env.GOOGLE_API_KEY;
if (databaseUrl === undefined || apiKey === undefined) {
  console.log("QG ERR DATABASE_URL and GOOGLE_API_KEY are required");
  process.exit(2);
}

const prisma = createPrismaClient(databaseUrl);
const workspaceId = randomUUID();
let failed = false;
try {
  const suffix = workspaceId.slice(0, 12);
  await prisma.workspace.create({
    data: { id: workspaceId, name: `Memory evaluation ${suffix}`, slug: `memory-eval-${suffix}` },
  });
  const gateway = new GeminiModelGateway({ apiKey });
  const repository = new MemoryRepository(prisma);
  const budget = new EmbeddingBudget(prisma);
  const ingester = createDocumentIngester({ repository, budget, embedder: gateway });

  // The title carries the passage id, so a hit can be matched to the answer key.
  for (const passage of GOLDEN_PASSAGES) {
    const result = await ingester.ingestDocument({
      workspaceId,
      title: passage.id,
      text: passage.text,
      language: passage.language,
    });
    if (result.status !== "CREATED") throw new Error(`ingest of ${passage.id}: ${result.status}`);
  }

  const vector: RankedResult[] = [];
  const keyword: RankedResult[] = [];
  const hybrid: RankedResult[] = [];
  const misses: unknown[] = [];
  for (const item of GOLDEN_QUESTIONS) {
    const embedded = await gateway.embed({ inputs: [item.question] });
    const queryEmbedding = embedded.vectors[0];
    if (queryEmbedding === undefined) throw new Error("no query vector");
    const hits = await repository.searchQuick({
      workspaceId,
      queryText: item.question,
      queryEmbedding,
      limit: 12,
      candidatesPerSearch: 12,
    });
    const byRank = (pick: (h: (typeof hits)[number]) => number | null): string[] =>
      hits
        .filter((h) => pick(h) !== null)
        .sort((a, b) => (pick(a) ?? 0) - (pick(b) ?? 0))
        .map((h) => h.sourceTitle);
    const row = (ranking: string[]): RankedResult => ({ ranking, expected: item.expected });
    vector.push(row(byRank((h) => h.vectorRank)));
    keyword.push(row(byRank((h) => h.keywordRank)));
    hybrid.push(row(hits.map((h) => h.sourceTitle)));
    if (hits[0]?.sourceTitle !== item.expected) {
      misses.push({
        question: item.question,
        kind: item.kind,
        expected: item.expected,
        top3: hits.slice(0, 3).map((h) => h.sourceTitle),
      });
    }
  }

  const slice = (rows: RankedResult[], kind: "same" | "cross"): RankedResult[] =>
    rows.filter((_, index) => GOLDEN_QUESTIONS[index]?.kind === kind);
  for (const [name, rows] of [
    ["vector", vector],
    ["keyword", keyword],
    ["hybrid", hybrid],
  ] as const) {
    console.log(
      "QG",
      name,
      JSON.stringify({
        all: summarizeRetrieval(rows),
        sameLanguage: summarizeRetrieval(slice(rows, "same")),
        crossLanguage: summarizeRetrieval(slice(rows, "cross")),
      }),
    );
  }
  console.log("QG top1-misses", JSON.stringify(misses));
  console.log("QG embedding-tokens-counted", await budget.usedToday(workspaceId));
} catch (error) {
  failed = true;
  console.log("QG ERR", error instanceof Error ? error.message : String(error));
} finally {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.$disconnect();
}
process.exit(failed ? 1 : 0);

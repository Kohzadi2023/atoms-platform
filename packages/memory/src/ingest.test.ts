import assert from "node:assert/strict";
import test from "node:test";

import {
  createDocumentIngester,
  EMBEDDING_DIMENSIONS,
  type EmbeddingBudget,
  type IngestInput,
  type MemoryRepository,
} from "./index.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const vector = (): number[] => new Array<number>(EMBEDDING_DIMENSIONS).fill(0.1);

class FakeBudget {
  used = 0;
  readonly adjustments: number[] = [];
  reserve(_workspaceId: string, tokens: number, cap: number): Promise<boolean> {
    if (this.used + tokens > cap) return Promise.resolve(false);
    this.used += tokens;
    return Promise.resolve(true);
  }
  adjust(_workspaceId: string, delta: number): Promise<void> {
    this.used = Math.max(0, this.used + delta);
    this.adjustments.push(delta);
    return Promise.resolve();
  }
}

class FakeRepository {
  existing: string | null = null;
  stored: IngestInput | undefined;
  failInsert = false;
  findSourceIdByHash(): Promise<string | null> {
    return Promise.resolve(this.existing);
  }
  ingest(input: IngestInput): Promise<{ status: "CREATED"; sourceId: string; chunkCount: number }> {
    if (this.failInsert) return Promise.reject(new Error("insert failed"));
    this.stored = input;
    return Promise.resolve({ status: "CREATED", sourceId: "source-1", chunkCount: input.chunks.length });
  }
}

function setup(embed?: (inputs: readonly string[]) => Promise<{ model: string; vectors: number[][]; usage: { totalTokens: number } }>) {
  const budget = new FakeBudget();
  const repository = new FakeRepository();
  const calls: string[][] = [];
  const ingester = createDocumentIngester({
    repository: repository as unknown as MemoryRepository,
    budget: budget as unknown as EmbeddingBudget,
    embedder: {
      embed: async ({ inputs }) => {
        calls.push([...inputs]);
        return embed
          ? embed(inputs)
          : { model: "m1", vectors: inputs.map(vector), usage: { totalTokens: inputs.length * 10 } };
      },
    },
  });
  return { budget, repository, calls, ingester };
}

const longDocument = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(60)}`).join("\n\n");

test("ingestDocument chunks, embeds, settles to real usage and stores", async () => {
  const { budget, repository, calls, ingester } = setup();
  const result = await ingester.ingestDocument({ workspaceId: WORKSPACE, title: "Doc", text: longDocument });
  assert.equal(result.status, "CREATED");
  assert.equal(calls.flat().length, repository.stored?.chunks.length);
  assert.equal(repository.stored?.embeddingModel, "m1");
  assert.equal(repository.stored?.chunks.every((c) => c.embedding.length === EMBEDDING_DIMENSIONS), true);
  assert.equal(budget.used, (repository.stored?.chunks.length ?? 0) * 10, "reservation settled to the provider's count");
});

test("ingestDocument counts the estimate when the provider reports no usage", async () => {
  const { budget, repository, ingester } = setup(async (inputs) => ({
    model: "m1",
    vectors: inputs.map(vector),
    usage: { totalTokens: 0 },
  }));
  await ingester.ingestDocument({ workspaceId: WORKSPACE, title: "Doc", text: longDocument });
  const estimate = (repository.stored?.chunks ?? []).reduce((sum, c) => sum + c.tokenCount, 0);
  assert.ok(estimate > 0);
  assert.equal(budget.used, estimate, "the cap sees the estimate, not zero");
});

test("ingestDocument sends at most 100 texts per request", async () => {
  const text = Array.from({ length: 400 }, (_, i) => `P${i} ${"x".repeat(1_100)}`).join("\n\n");
  const { calls, ingester } = setup();
  await ingester.ingestDocument({ workspaceId: WORKSPACE, title: "Big", text, dailyTokenCap: 10_000_000 });
  assert.ok(calls.length >= 4);
  assert.ok(calls.every((batch) => batch.length >= 1 && batch.length <= 100));
});

test("ingestDocument spends nothing on a document the workspace already has", async () => {
  const { budget, repository, calls, ingester } = setup();
  repository.existing = "source-0";
  const result = await ingester.ingestDocument({ workspaceId: WORKSPACE, title: "Doc", text: longDocument });
  assert.deepEqual(result, { status: "DUPLICATE", sourceId: "source-0" });
  assert.equal(calls.length, 0);
  assert.equal(budget.used, 0);
});

test("ingestDocument refuses, and embeds nothing, when the daily cap would be passed", async () => {
  const { budget, repository, calls, ingester } = setup();
  const result = await ingester.ingestDocument({
    workspaceId: WORKSPACE,
    title: "Doc",
    text: longDocument,
    dailyTokenCap: 100,
  });
  assert.equal(result.status, "DAILY_CAP_EXCEEDED");
  assert.equal(calls.length, 0);
  assert.equal(repository.stored, undefined);
  assert.equal(budget.used, 0);
});

test("ingestDocument gives the reservation back when the provider fails", async () => {
  const { budget, repository, ingester } = setup(() => Promise.reject(new Error("provider down")));
  await assert.rejects(
    ingester.ingestDocument({ workspaceId: WORKSPACE, title: "Doc", text: longDocument }),
    /provider down/u,
  );
  assert.equal(budget.used, 0);
  assert.equal(repository.stored, undefined);
});

test("ingestDocument keeps the spend when only the database insert fails", async () => {
  const { budget, repository, ingester } = setup();
  repository.failInsert = true;
  await assert.rejects(
    ingester.ingestDocument({ workspaceId: WORKSPACE, title: "Doc", text: longDocument }),
    /insert failed/u,
  );
  assert.ok(budget.used > 0, "the embedding call was paid for");
});

test("ingestDocument rejects an empty document and a short vector count", async () => {
  const { ingester } = setup();
  await assert.rejects(ingester.ingestDocument({ workspaceId: WORKSPACE, title: "Empty", text: " \n " }), RangeError);
  const broken = setup(async () => ({ model: "m1", vectors: [], usage: { totalTokens: 1 } }));
  await assert.rejects(
    broken.ingester.ingestDocument({ workspaceId: WORKSPACE, title: "Doc", text: "hello there" }),
    /0 vectors for 1 texts/u,
  );
  assert.equal(broken.budget.used, 0);
});

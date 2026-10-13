import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPrismaClient } from "@atoms/db";

import { chunkText, contentHash, EMBEDDING_DIMENSIONS, MemoryRepository } from "./index.js";

const ENABLED = process.env.RUN_MEMORY_INTEGRATION_TESTS === "true";
const CONFIRMATION = "DEDICATED_EPHEMERAL_DATABASE";

/** A unit vector along one axis: different axes are orthogonal, so cosine ranking is unambiguous. */
function axis(index: number, noise = 0): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  vector[(index + 1) % EMBEDDING_DIMENSIONS] = noise;
  return vector;
}

test(
  "memory repository: hybrid search, tenant isolation, idempotent ingest and cascading delete",
  { skip: !ENABLED },
  async () => {
    assert.equal(
      process.env.MEMORY_INTEGRATION_CONFIRMATION,
      CONFIRMATION,
      `MEMORY_INTEGRATION_CONFIRMATION must equal ${CONFIRMATION}`,
    );
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl, "DATABASE_URL is required");

    const prisma = createPrismaClient(databaseUrl);
    const suffix = randomUUID().slice(0, 12);
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    try {
      for (const [id, label] of [
        [workspaceA, "a"],
        [workspaceB, "b"],
      ] as const) {
        await prisma.workspace.create({
          data: { id, name: `Memory integration ${label} ${suffix}`, slug: `memory-${label}-${suffix}` },
        });
      }
      const repository = new MemoryRepository(prisma);
      const model = "gemini-embedding-001";

      const hoursText = "Our opening hours are nine to five, Monday to Friday.";
      const persianText = "ساعت کاری ما از شنبه تا چهارشنبه، نه صبح تا پنج عصر است.";
      const pricesText = "A haircut costs forty dollars and a colour treatment costs ninety.";
      const sources = [
        { title: "Hours", text: hoursText, axis: 0 },
        { title: "ساعت کاری", text: persianText, axis: 1 },
        { title: "Prices", text: pricesText, axis: 2 },
      ];
      const ingested = [];
      for (const source of sources) {
        const chunks = chunkText(source.text).map((chunk) => ({ ...chunk, embedding: axis(source.axis) }));
        const result = await repository.ingest({
          workspaceId: workspaceA,
          title: source.title,
          contentHash: contentHash(source.text),
          embeddingModel: model,
          chunks,
        });
        assert.equal(result.status, "CREATED");
        ingested.push(result);
      }

      // Ingesting identical text again in the same workspace is a no-op that names the existing source.
      const again = await repository.ingest({
        workspaceId: workspaceA,
        title: "Hours (copy)",
        contentHash: contentHash(hoursText),
        embeddingModel: model,
        chunks: chunkText(hoursText).map((chunk) => ({ ...chunk, embedding: axis(0) })),
      });
      assert.equal(again.status, "DUPLICATE");
      assert.equal(again.sourceId, ingested[0]?.sourceId);

      // The same text in another workspace is its own source, and a secret that only B holds.
      const secretText = "The safe code is 4417 and the alarm phrase is plum.";
      await repository.ingest({
        workspaceId: workspaceB,
        title: "B secret",
        contentHash: contentHash(secretText),
        embeddingModel: model,
        chunks: chunkText(secretText).map((chunk) => ({ ...chunk, embedding: axis(2, 0.05) })),
      });
      const duplicateInB = await repository.ingest({
        workspaceId: workspaceB,
        title: "Hours in B",
        contentHash: contentHash(hoursText),
        embeddingModel: model,
        chunks: chunkText(hoursText).map((chunk) => ({ ...chunk, embedding: axis(0) })),
      });
      assert.equal(duplicateInB.status, "CREATED");

      // Vector side: a query pointing along axis 2 finds the prices passage first.
      const byVector = await repository.searchQuick({
        workspaceId: workspaceA,
        queryText: "",
        queryEmbedding: axis(2),
        limit: 3,
      });
      assert.equal(byVector[0]?.sourceTitle, "Prices");
      assert.equal(byVector[0]?.keywordRank, null);
      assert.equal(byVector[0]?.vectorRank, 1);

      // Keyword side: a vector that matches nothing in particular, a question that names the passage.
      const byKeyword = await repository.searchQuick({
        workspaceId: workspaceA,
        queryText: "What are your opening hours?",
        queryEmbedding: axis(100),
        limit: 3,
      });
      assert.equal(byKeyword[0]?.sourceTitle, "Hours");
      assert.notEqual(byKeyword[0]?.keywordRank, null);

      // Persian text is searchable by Persian words.
      const byPersian = await repository.searchQuick({
        workspaceId: workspaceA,
        queryText: "ساعت کاری چهارشنبه",
        queryEmbedding: axis(100),
        limit: 3,
      });
      assert.equal(byPersian[0]?.sourceTitle, "ساعت کاری");
      assert.notEqual(byPersian[0]?.keywordRank, null);

      // Agreement of both searches ranks above either alone.
      const both = await repository.searchQuick({
        workspaceId: workspaceA,
        queryText: "opening hours",
        queryEmbedding: axis(0),
        limit: 3,
      });
      assert.equal(both[0]?.sourceTitle, "Hours");
      assert.equal(both[0]?.vectorRank, 1);
      assert.equal(both[0]?.keywordRank, 1);
      assert.ok((both[0]?.score ?? 0) > (both[1]?.score ?? 0));

      // Tenant isolation: workspace A can never see B's secret, however well it matches.
      for (const queryText of ["safe code 4417 alarm plum", "plum"]) {
        const leak = await repository.searchQuick({
          workspaceId: workspaceA,
          queryText,
          queryEmbedding: axis(2, 0.05),
          limit: 10,
        });
        assert.ok(leak.every((hit) => hit.text !== secretText && hit.sourceTitle !== "B secret"));
      }
      const own = await repository.searchQuick({
        workspaceId: workspaceB,
        queryText: "alarm phrase plum",
        queryEmbedding: axis(2, 0.05),
        limit: 10,
      });
      assert.equal(own[0]?.sourceTitle, "B secret");
      assert.ok(own.every((hit) => hit.sourceTitle !== "Prices"));

      // Deletion: another workspace cannot delete the source; the owner can, and the chunks go with it.
      const hoursSourceId = ingested[0]?.sourceId;
      assert.ok(hoursSourceId);
      assert.equal(await repository.deleteSource(workspaceB, hoursSourceId), false);
      assert.equal(await repository.deleteSource(workspaceA, hoursSourceId), true);
      assert.equal(await repository.deleteSource(workspaceA, hoursSourceId), false);
      const chunksLeft = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM memory_chunks WHERE source_id = ${hoursSourceId}::uuid`;
      assert.equal(Number(chunksLeft[0]?.n), 0);
      const afterDelete = await repository.searchQuick({
        workspaceId: workspaceA,
        queryText: "opening hours",
        queryEmbedding: axis(0),
        limit: 10,
      });
      assert.ok(afterDelete.every((hit) => hit.sourceId !== hoursSourceId));

      // A wrong-sized vector is refused before anything is written.
      await assert.rejects(
        repository.ingest({
          workspaceId: workspaceA,
          title: "Bad",
          contentHash: contentHash("bad"),
          embeddingModel: model,
          chunks: [{ position: 0, text: "bad", tokenCount: 1, embedding: [1, 2, 3] }],
        }),
        /expected 768/u,
      );
    } finally {
      // Deleting the workspaces cascades to sources and chunks.
      await prisma.workspace.deleteMany({ where: { id: { in: [workspaceA, workspaceB] } } });
      await prisma.$disconnect();
    }
  },
);

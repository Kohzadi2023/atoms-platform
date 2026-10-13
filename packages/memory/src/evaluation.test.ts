import assert from "node:assert/strict";
import test from "node:test";

import { GOLDEN_PASSAGES, GOLDEN_QUESTIONS, rankOf, summarizeRetrieval } from "./index.js";

test("rankOf is 1-based and null when the answer was not retrieved", () => {
  assert.equal(rankOf({ ranking: ["a", "b", "c"], expected: "a" }), 1);
  assert.equal(rankOf({ ranking: ["a", "b", "c"], expected: "c" }), 3);
  assert.equal(rankOf({ ranking: ["a"], expected: "z" }), null);
});

test("summarizeRetrieval computes recall at 1 and 3 and mean reciprocal rank", () => {
  const summary = summarizeRetrieval([
    { ranking: ["x", "y"], expected: "x" }, // rank 1
    { ranking: ["a", "b", "x"], expected: "x" }, // rank 3
    { ranking: ["a", "b", "c", "x"], expected: "x" }, // rank 4
    { ranking: [], expected: "x" }, // missing
  ]);
  assert.deepEqual(summary, {
    questions: 4,
    recallAt1: 0.25,
    recallAt3: 0.5,
    meanReciprocalRank: 0.396, // (1 + 1/3 + 1/4 + 0) / 4
  });
  assert.deepEqual(summarizeRetrieval([]), {
    questions: 0,
    recallAt1: 0,
    recallAt3: 0,
    meanReciprocalRank: 0,
  });
});

test("the golden set is well-formed: every answer exists, both languages and kinds are present, languages are labelled correctly", () => {
  const ids = new Set(GOLDEN_PASSAGES.map((p) => p.id));
  assert.equal(ids.size, GOLDEN_PASSAGES.length, "passage ids are unique");
  const byId = new Map(GOLDEN_PASSAGES.map((p) => [p.id, p]));
  const persian = /[؀-ۿ]/u;
  for (const passage of GOLDEN_PASSAGES) {
    assert.equal(persian.test(passage.text), passage.language === "fa", `passage ${passage.id} language label`);
  }
  for (const item of GOLDEN_QUESTIONS) {
    const passage = byId.get(item.expected);
    assert.ok(passage, `answer ${item.expected} exists`);
    assert.equal(persian.test(item.question), item.language === "fa", `question language label: ${item.question}`);
    assert.equal(item.kind, item.language === passage.language ? "same" : "cross", `kind of: ${item.question}`);
  }
  assert.ok(GOLDEN_QUESTIONS.some((q) => q.kind === "cross") && GOLDEN_QUESTIONS.some((q) => q.kind === "same"));
  // every passage is asked about at least twice
  for (const passage of GOLDEN_PASSAGES) {
    assert.ok(GOLDEN_QUESTIONS.filter((q) => q.expected === passage.id).length >= 2);
  }
});

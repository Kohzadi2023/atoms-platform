import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkText,
  contentHash,
  estimateTokens,
  normalizeText,
  reciprocalRankFusion,
} from "./index.js";

test("normalizeText unifies line endings and spaces but keeps the zero-width non-joiner", () => {
  const raw = "می‌خواهم  \r\n\r\n\r\n\r\nسلام\t دنیا ";
  assert.equal(normalizeText(raw), "می‌خواهم\n\nسلام دنیا");
});

test("contentHash is stable across equivalent spellings and differs for different text", () => {
  assert.equal(contentHash("a  b\r\n"), contentHash("a b"));
  assert.equal(contentHash("é"), contentHash("é"));
  assert.notEqual(contentHash("a b"), contentHash("a c"));
  assert.match(contentHash("x"), /^[0-9a-f]{64}$/u);
});

test("chunkText returns nothing for empty input", () => {
  assert.deepEqual(chunkText(" \n\n \t"), []);
});

test("chunkText keeps a short document as one chunk", () => {
  const chunks = chunkText("Opening hours are 9 to 5.");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.position, 0);
  assert.equal(chunks[0]?.text, "Opening hours are 9 to 5.");
  assert.equal(chunks[0]?.tokenCount, estimateTokens("Opening hours are 9 to 5."));
});

test("chunkText packs paragraphs and never exceeds the limit plus overlap", () => {
  const paragraph = "word ".repeat(40).trim(); // 199 chars
  const doc = Array.from({ length: 12 }, () => paragraph).join("\n\n");
  const chunks = chunkText(doc, { maxChars: 500, overlapChars: 60 });
  assert.ok(chunks.length > 1);
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.position, index);
    assert.ok(chunk.text.length <= 500 + 60 + 1, `chunk ${index} is ${chunk.text.length} chars`);
  });
});

test("chunkText overlap starts on a word boundary and repeats the previous tail", () => {
  const doc = Array.from({ length: 6 }, (_, i) => `${"alpha ".repeat(30).trim()} end${i}`).join("\n\n");
  const chunks = chunkText(doc, { maxChars: 400, overlapChars: 40 });
  assert.ok(chunks.length > 1);
  const first = chunks[0]!.text;
  const second = chunks[1]!.text;
  const overlap = second.split("\n")[0]!;
  assert.ok(first.endsWith(overlap), "overlap is the tail of the previous chunk");
  assert.ok(overlap.length <= 40);
});

test("chunkText splits a long paragraph at sentence ends, Persian question mark included", () => {
  const sentence = "این یک جمله است؟ ";
  const doc = sentence.repeat(120).trim();
  const chunks = chunkText(doc, { maxChars: 300, overlapChars: 0 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 300);
    assert.ok(chunk.text.endsWith("؟"), "cut at a sentence end");
  }
});

test("chunkText cuts text with no boundaries at a space, and still terminates without one", () => {
  const withSpaces = chunkText("abcde ".repeat(100), { maxChars: 100, overlapChars: 0 });
  assert.ok(withSpaces.every((c) => c.text.length <= 100));
  const noSpaces = chunkText("x".repeat(1000), { maxChars: 100, overlapChars: 0 });
  assert.equal(noSpaces.length, 10);
});

test("chunkText is deterministic and loses no words", () => {
  const doc = Array.from({ length: 30 }, (_, i) => `Service ${i} costs ${i * 10} dollars. هزینه ${i}.`).join("\n\n");
  const a = chunkText(doc, { maxChars: 300, overlapChars: 50 });
  const b = chunkText(doc, { maxChars: 300, overlapChars: 50 });
  assert.deepEqual(a, b);
  const joined = a.map((c) => c.text).join("\n");
  for (let i = 0; i < 30; i += 1) assert.ok(joined.includes(`Service ${i} costs`));
});

test("chunkText rejects unusable limits", () => {
  assert.throws(() => chunkText("x", { maxChars: 10 }), RangeError);
  assert.throws(() => chunkText("x", { maxChars: 200, overlapChars: 100 }), RangeError);
  assert.throws(() => chunkText("x", { overlapChars: -1 }), RangeError);
});

test("reciprocalRankFusion rewards agreement between lists", () => {
  const vector = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const keyword = [{ id: "b" }, { id: "d" }, { id: "a" }];
  const fused = reciprocalRankFusion([vector, keyword]);
  assert.deepEqual(
    fused.map((h) => h.id),
    ["b", "a", "d", "c"],
  );
  assert.deepEqual(fused[0]?.ranks, [2, 1]);
  assert.deepEqual(fused.find((h) => h.id === "c")?.ranks, [3, null]);
});

test("reciprocalRankFusion is deterministic on ties, counts a duplicate once, and honours limit", () => {
  const fused = reciprocalRankFusion([[{ id: "z" }, { id: "z" }, { id: "y" }], [{ id: "y" }]], { limit: 1 });
  assert.equal(fused.length, 1);
  // z: 1/61 ; y: 1/63 + 1/61 -> y wins
  assert.equal(fused[0]?.id, "y");
  const tie = reciprocalRankFusion([[{ id: "b" }], [{ id: "a" }]]);
  assert.deepEqual(tie.map((h) => h.id), ["a", "b"]);
});

test("reciprocalRankFusion handles no lists and rejects a bad k", () => {
  assert.deepEqual(reciprocalRankFusion([]), []);
  assert.throws(() => reciprocalRankFusion([[]], { k: 0 }), RangeError);
});

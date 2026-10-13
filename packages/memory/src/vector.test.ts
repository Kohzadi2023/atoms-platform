import assert from "node:assert/strict";
import test from "node:test";

import { EMBEDDING_DIMENSIONS, toKeywordQuery, toVectorLiteral } from "./index.js";

test("toVectorLiteral formats pgvector text input", () => {
  assert.equal(toVectorLiteral([0.5, -1, 2], 3), "[0.5,-1,2]");
  assert.equal(toVectorLiteral(new Array<number>(EMBEDDING_DIMENSIONS).fill(0)).length, 2 + 2 * EMBEDDING_DIMENSIONS - 1);
});

test("toVectorLiteral rejects a wrong size and non-finite numbers", () => {
  assert.throws(() => toVectorLiteral([1, 2]), /expected 768/u);
  assert.throws(() => toVectorLiteral([1, Number.NaN], 2), /non-finite/u);
  assert.throws(() => toVectorLiteral([1, Number.POSITIVE_INFINITY], 2), /non-finite/u);
});

test("toKeywordQuery matches any word and keeps Persian and digits", () => {
  assert.equal(toKeywordQuery("What are the Opening Hours?"), "opening | hours");
  assert.equal(toKeywordQuery("ساعت کاری شنبه ۹ تا ۵"), "ساعت | کاری | شنبه | ۹ | ۵");
  assert.equal(toKeywordQuery("price price PRICE"), "price");
});

test("toKeywordQuery strips anything that could be query syntax and caps the term count", () => {
  assert.equal(toKeywordQuery("foo & bar | !baz ' ) ( :* <->"), "foo | bar | baz");
  assert.equal(toKeywordQuery("   ... --- "), null);
  assert.equal(toKeywordQuery(""), null);
  const many = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
  assert.equal(toKeywordQuery(many)?.split(" | ").length, 32);
});

test("toKeywordQuery drops common function words and single letters but keeps digits and rare words", () => {
  assert.equal(toKeywordQuery("Do you see children and is the first visit free?"), "see | children | first | visit | free");
  assert.equal(toKeywordQuery("آیا کودک ۸ ساله را هم می‌پذیرید؟"), "کودک | ۸ | ساله | پذیرید");
  assert.equal(toKeywordQuery("call 416-555-0142"), "call | 416 | 555 | 0142");
  assert.equal(toKeywordQuery("is the a of"), null);
  assert.equal(toKeywordQuery("x"), null);
});

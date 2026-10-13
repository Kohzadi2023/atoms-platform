/** The vector size the schema (`memory_chunks.embedding vector(768)`) and the embedder agree on. */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * pgvector's text input form, `[0.1,0.2,...]`, passed as a bound parameter and
 * cast with `::vector` in SQL. Rejects a wrong size or a non-finite number here,
 * with a clear message, instead of as a database error later.
 */
export function toVectorLiteral(values: readonly number[], dimensions = EMBEDDING_DIMENSIONS): string {
  if (values.length !== dimensions) {
    throw new RangeError(`embedding has ${values.length} dimensions, expected ${dimensions}`);
  }
  for (const value of values) {
    if (!Number.isFinite(value)) throw new RangeError("embedding contains a non-finite number");
  }
  return `[${values.join(",")}]`;
}

const MAX_KEYWORD_TERMS = 32;

/**
 * Turn free text into a `to_tsquery('simple', ...)` expression that matches ANY
 * of its words (`a | b | c`). `plainto_tsquery` would require ALL words, which
 * returns nothing for a natural-language question. Only letters and digits
 * survive, so nothing from the user can be read as query syntax. Returns null
 * when there is nothing to search for.
 */
export function toKeywordQuery(text: string): string | null {
  const terms = new Set<string>();
  for (const match of text.normalize("NFC").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    terms.add(match[0]);
    if (terms.size >= MAX_KEYWORD_TERMS) break;
  }
  return terms.size === 0 ? null : [...terms].join(" | ");
}

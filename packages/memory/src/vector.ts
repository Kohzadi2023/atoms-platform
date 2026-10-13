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
 * Words that appear in almost every question and passage. Left in, they made the
 * keyword list rank unrelated passages first and dragged the fused result below
 * the vector search alone (golden-set run on staging, 2026-10-13). A short list of
 * the most common English and Persian function words, not a linguistic resource.
 * Persian words are listed in their split form: the zero-width non-joiner is not a
 * letter, so "می‌شود" is the two tokens "می" and "شود".
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  ..."a an the is are was were be been am do does did you your yours i my me we our us it its of to in on at for and or but if any there with by from that this these those have has had will would should can could may how what when where who which whom why so as not no".split(" "),
  ..."و در به از که را این آن با برای است هست هستند هستید هستم بود باشد باشند می شود شد شده کرد کند کنم کنید کنند دارد دارند دارید دارم یا هم من شما ما او آنها ایشان تا بر یک آیا چه چی چند چقدر کجا کی چرا چطور چگونه اگر باید بشود نه ولی اما پس همه هر".split(" "),
]);

/**
 * Turn free text into a `to_tsquery('simple', ...)` expression that matches ANY
 * of its words (`a | b | c`). `plainto_tsquery` would require ALL words, which
 * returns nothing for a natural-language question. Only letters and digits
 * survive, so nothing from the user can be read as query syntax. Very common
 * words and single letters are dropped. Returns null when there is nothing left
 * to search for.
 */
export function toKeywordQuery(text: string): string | null {
  const terms = new Set<string>();
  for (const match of text.normalize("NFC").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0];
    if (STOP_WORDS.has(term) || (term.length === 1 && !/\p{N}/u.test(term))) continue;
    terms.add(term);
    if (terms.size >= MAX_KEYWORD_TERMS) break;
  }
  return terms.size === 0 ? null : [...terms].join(" | ");
}

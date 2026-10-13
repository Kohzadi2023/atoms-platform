import { createHash } from "node:crypto";

export interface ChunkOptions {
  /** Upper bound for one chunk, in characters. */
  readonly maxChars?: number;
  /** Characters repeated from the end of the previous chunk, for context. */
  readonly overlapChars?: number;
}

export interface TextChunk {
  readonly position: number;
  readonly text: string;
  readonly tokenCount: number;
}

export const DEFAULT_MAX_CHARS = 1_200;
export const DEFAULT_OVERLAP_CHARS = 150;

/**
 * Cheap, conservative token estimate. Persian and English both tokenise to
 * roughly 3 to 4 characters per token, so 3 errs on the side of counting more.
 * Used only for budgeting, never for splitting.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Canonical form of a document before hashing and chunking. NFC keeps the same
 * visible text from hashing differently. The zero-width non-joiner (U+200C) is
 * deliberately kept: it is part of correct Persian spelling.
 */
export function normalizeText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v  ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function contentHash(raw: string): string {
  return createHash("sha256").update(normalizeText(raw), "utf8").digest("hex");
}

// Sentence ends: Latin, Arabic question mark, Urdu full stop, and the ellipsis character.
const SENTENCE_END = /(?<=[.!?؟۔…])\s+/u;

function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  const pieces: string[] = [];
  for (const sentence of paragraph.split(SENTENCE_END)) {
    if (sentence.length <= maxChars) {
      pieces.push(sentence);
      continue;
    }
    // A sentence with no usable boundary: cut at the last space before the limit.
    let rest = sentence;
    while (rest.length > maxChars) {
      const cut = rest.lastIndexOf(" ", maxChars);
      const at = cut > maxChars / 2 ? cut : maxChars;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest.length > 0) pieces.push(rest);
  }
  return pieces;
}

function tailForOverlap(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length <= overlapChars) return "";
  const tail = text.slice(text.length - overlapChars);
  const space = tail.indexOf(" ");
  // Start the overlap on a word boundary so a word is never cut in half.
  return space === -1 ? "" : tail.slice(space + 1);
}

/**
 * Split a document into passages of at most `maxChars` (plus the overlap),
 * preferring paragraph, then sentence, then word boundaries. Deterministic:
 * the same text always yields the same chunks, so re-ingesting is idempotent.
 */
export function chunkText(raw: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 50) {
    throw new RangeError("maxChars must be an integer of at least 50");
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars / 2) {
    throw new RangeError("overlapChars must be an integer from 0 to less than half of maxChars");
  }

  const text = normalizeText(raw);
  if (text.length === 0) return [];

  const pieces = text
    .split(/\n{2,}/u)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .flatMap((p) => (p.length <= maxChars ? [p] : splitLongParagraph(p, maxChars)));

  const bodies: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const joined = current === "" ? piece : `${current}\n\n${piece}`;
    if (joined.length <= maxChars) {
      current = joined;
      continue;
    }
    if (current !== "") bodies.push(current);
    current = piece;
  }
  if (current !== "") bodies.push(current);

  return bodies.map((body, position) => {
    const previous = position > 0 ? bodies[position - 1] : undefined;
    const overlap = previous === undefined ? "" : tailForOverlap(previous, overlapChars);
    const chunkText = overlap === "" ? body : `${overlap}\n${body}`;
    return { position, text: chunkText, tokenCount: estimateTokens(chunkText) };
  });
}

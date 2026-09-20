export interface ThrottledLoggerOptions {
  /** Where lines go. Defaults to console.error. */
  readonly write?: (...args: unknown[]) => void;
  /** Repeats of the same error inside this window are counted, not printed. */
  readonly intervalMs?: number;
  readonly now?: () => number;
  /** Bounds memory when the messages are all different. */
  readonly maxKeys?: number;
}

interface Entry {
  windowStart: number;
  suppressed: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_KEYS = 200;
const KEY_MESSAGE_LENGTH = 160;

/**
 * A worker whose Redis or database is misconfigured can report the same error hundreds of
 * thousands of times an hour, each with a full stack trace. On Azure that once meant 230 GB
 * of Log Analytics a day and a bill of about CAD 900 a day. This prints an error in full
 * the first time, then at most one short summary per window with how often it repeated.
 *
 * Errors are told apart by label, error name and the start of the message, so a new kind of
 * error is never hidden behind an old one. `context` (for example a job id) is printed with
 * the first occurrence but is not part of the key, so a failure on many jobs is still one key.
 */
export function createThrottledLogger(options: ThrottledLoggerOptions = {}) {
  const write = options.write ?? ((...args: unknown[]) => console.error(...args));
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const entries = new Map<string, Entry>();

  return function logError(label: string, error: unknown, context?: unknown): void {
    const key = `${label}|${describe(error)}`;
    const at = now();
    const entry = entries.get(key);

    if (entry === undefined) {
      if (entries.size >= maxKeys) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { windowStart: at, suppressed: 0 });
      write(...(context === undefined ? [label, error] : [label, context, error]));
      return;
    }

    if (at - entry.windowStart < intervalMs) {
      entry.suppressed += 1;
      return;
    }

    // The window is over: say how many were skipped, in one line without the stack, and
    // start a new window. If nothing was skipped, this is a fresh occurrence: print it in full.
    const skipped = entry.suppressed;
    entry.windowStart = at;
    entry.suppressed = 0;
    if (skipped === 0) {
      write(...(context === undefined ? [label, error] : [label, context, error]));
      return;
    }
    write(
      `${label}: ${describe(error)} (repeated ${String(skipped)} more times in the last ${String(Math.round(intervalMs / 1_000))}s, stack trace suppressed)`,
    );
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message.slice(0, KEY_MESSAGE_LENGTH)}`;
  }
  return String(error).slice(0, KEY_MESSAGE_LENGTH);
}

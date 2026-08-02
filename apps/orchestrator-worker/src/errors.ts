import type { JsonValue } from "@atoms/contracts";
import { ZodError } from "zod";

export class RunStoppedError extends Error {
  override readonly name = "RunStoppedError";
  readonly status: string;

  constructor(message: string, status: string) {
    super(message);
    this.status = status;
  }
}

export class GeneratedFileConflictError extends Error {
  override readonly name = "GeneratedFileConflictError";
  readonly retryable = false;
  readonly path: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(path: string, expectedVersion: number, actualVersion: number) {
    super(
      `Generated file ${path} expected version ${String(expectedVersion)} but found ${String(actualVersion)}`,
    );
    this.path = path;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export function findRunStoppedError(error: unknown): RunStoppedError | null {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 10 && current !== undefined; depth += 1) {
    if (current instanceof RunStoppedError) return current;
    if (
      typeof current !== "object" ||
      current === null ||
      seen.has(current) ||
      !("cause" in current)
    ) {
      return null;
    }
    seen.add(current);
    current = current.cause;
  }
  return null;
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof ZodError || error instanceof GeneratedFileConflictError) {
    return false;
  }

  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 10 && current !== undefined; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "retryable" in current &&
      typeof current.retryable === "boolean"
    ) {
      return current.retryable;
    }
    if (
      typeof current !== "object" ||
      current === null ||
      seen.has(current) ||
      !("cause" in current)
    ) {
      break;
    }
    seen.add(current);
    current = current.cause;
  }
  return true;
}

export function toWorkerError(error: unknown): JsonValue {
  const stopped = findRunStoppedError(error);
  const effective = stopped ?? error;
  const message =
    effective instanceof Error ? effective.message : "Orchestration failed";
  const name = effective instanceof Error ? effective.name : "UnknownError";
  const code =
    typeof effective === "object" &&
    effective !== null &&
    "code" in effective &&
    typeof effective.code === "string"
      ? effective.code
      : name;

  return {
    code,
    name,
    message,
    retryable: isRetryableError(error),
  };
}

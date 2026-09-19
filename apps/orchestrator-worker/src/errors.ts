import type { JsonValue, RunFailureReason } from "@atoms/contracts";
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

const BUDGET_EXHAUSTION_CODES: ReadonlySet<string> = new Set([
  "PROVIDER_BUDGET_EXCEEDED",
  "WORKSPACE_BUDGET_EXCEEDED",
]);
const PROVIDER_ERROR_NAMES: ReadonlySet<string> = new Set([
  "ProviderBudgetError",
  "ModelGatewayError",
  "SandboxProviderError",
]);

// Matches on name and code rather than instanceof so that wrapped errors
// (checked along the cause chain) and errors from other packages classify
// without importing them here.
export function classifyRunFailure(error: unknown): RunFailureReason {
  let current = error;
  const seen = new Set<unknown>();
  let providerSeen = false;
  for (let depth = 0; depth < 10 && current !== undefined; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      break;
    }
    seen.add(current);
    const code =
      "code" in current && typeof current.code === "string" ? current.code : "";
    const name =
      "name" in current && typeof current.name === "string" ? current.name : "";
    if (BUDGET_EXHAUSTION_CODES.has(code)) return "FAILED_BUDGET_EXHAUSTED";
    if (name === "SandboxValidationError" || code === "SANDBOX_VALIDATION_FAILED") {
      return "FAILED_VALIDATION";
    }
    if (PROVIDER_ERROR_NAMES.has(name)) providerSeen = true;
    current = "cause" in current ? current.cause : undefined;
  }
  return providerSeen ? "FAILED_PROVIDER" : "FAILED_INTERNAL";
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
    reason: classifyRunFailure(error),
  };
}

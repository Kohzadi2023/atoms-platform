import {
  AuthenticationError,
  RateLimitError,
  SandboxNotFoundError,
  TimeoutError,
} from "@e2b/code-interpreter";
import { ZodError } from "zod";

export type SandboxOperation =
  | "connect"
  | "create"
  | "exec"
  | "exposePort"
  | "startProcess"
  | "terminate"
  | "writeFiles";

export type SandboxProviderErrorCode =
  | "AUTHENTICATION"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "PROVIDER_ERROR"
  | "RATE_LIMITED"
  | "TIMEOUT";

export interface SandboxProviderErrorOptions {
  readonly code: SandboxProviderErrorCode;
  readonly operation: SandboxOperation;
  readonly retryable: boolean;
  readonly sandboxId?: string;
  readonly cause?: unknown;
}

export class SandboxProviderError extends Error {
  override readonly name = "SandboxProviderError";
  readonly code: SandboxProviderErrorCode;
  readonly operation: SandboxOperation;
  readonly retryable: boolean;
  readonly sandboxId: string | undefined;

  constructor(message: string, options: SandboxProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.code = options.code;
    this.operation = options.operation;
    this.retryable = options.retryable;
    this.sandboxId = options.sandboxId;
  }
}

export function normalizeE2BError(
  error: unknown,
  operation: SandboxOperation,
  sandboxId?: string,
): SandboxProviderError {
  if (error instanceof SandboxProviderError) {
    return error;
  }

  if (error instanceof ZodError) {
    return new SandboxProviderError("Invalid sandbox provider input", {
      code: "INVALID_INPUT",
      operation,
      retryable: false,
      ...(sandboxId === undefined ? {} : { sandboxId }),
      cause: error,
    });
  }

  const details =
    error instanceof Error && error.message.length > 0
      ? error.message
      : `E2B ${operation} failed`;
  const common = {
    operation,
    ...(sandboxId === undefined ? {} : { sandboxId }),
    cause: error,
  };

  if (error instanceof AuthenticationError) {
    return new SandboxProviderError(details, {
      ...common,
      code: "AUTHENTICATION",
      retryable: false,
    });
  }
  if (error instanceof RateLimitError) {
    return new SandboxProviderError(details, {
      ...common,
      code: "RATE_LIMITED",
      retryable: true,
    });
  }
  if (error instanceof SandboxNotFoundError) {
    return new SandboxProviderError(details, {
      ...common,
      code: "NOT_FOUND",
      retryable: false,
    });
  }
  if (
    error instanceof TimeoutError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new SandboxProviderError(details, {
      ...common,
      code: "TIMEOUT",
      retryable: true,
    });
  }

  return new SandboxProviderError(details, {
    ...common,
    code: "PROVIDER_ERROR",
    retryable: false,
  });
}

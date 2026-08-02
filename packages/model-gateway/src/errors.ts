import { APIError } from "openai";

export type ModelGatewayErrorCode =
  | "AUTHENTICATION"
  | "INVALID_REQUEST"
  | "PROVIDER_ERROR"
  | "RATE_LIMITED"
  | "RESPONSE_FAILED"
  | "TIMEOUT";

export interface ModelGatewayErrorOptions {
  readonly code: ModelGatewayErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly providerRequestId?: string;
  readonly cause?: unknown;
}

export class ModelGatewayError extends Error {
  override readonly name = "ModelGatewayError";
  readonly code: ModelGatewayErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly providerRequestId: string | undefined;

  constructor(message: string, options: ModelGatewayErrorOptions) {
    super(message, { cause: options.cause });
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.providerRequestId = options.providerRequestId;
  }
}

export function normalizeOpenAIError(error: unknown): ModelGatewayError {
  if (error instanceof ModelGatewayError) {
    return error;
  }

  if (error instanceof APIError) {
    const status = error.status;
    const code: ModelGatewayErrorCode =
      status === 401 || status === 403
        ? "AUTHENTICATION"
        : status === 400 || status === 404 || status === 422
          ? "INVALID_REQUEST"
          : status === 408
            ? "TIMEOUT"
            : status === 429
              ? "RATE_LIMITED"
              : "PROVIDER_ERROR";
    const retryable = status === undefined || status === 408 || status === 429 || status >= 500;

    return new ModelGatewayError(error.message, {
      code,
      retryable,
      ...(status === undefined ? {} : { status }),
      ...(error.requestID == null
        ? {}
        : { providerRequestId: error.requestID }),
      cause: error,
    });
  }

  return new ModelGatewayError(
    error instanceof Error ? error.message : "OpenAI request failed",
    {
      code: "PROVIDER_ERROR",
      retryable: false,
      cause: error,
    },
  );
}


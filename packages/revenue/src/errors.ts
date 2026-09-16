export class RevenueProviderError extends Error {
  override readonly name = "RevenueProviderError";
  readonly provider: "APOLLO" | "HUBSPOT";
  readonly code: string;
  readonly retryable: boolean;
  override readonly cause: unknown;

  constructor(
    message: string,
    options: {
      readonly provider: "APOLLO" | "HUBSPOT";
      readonly code: string;
      readonly retryable: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message);
    this.provider = options.provider;
    this.code = options.code;
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
}

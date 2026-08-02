export class DatabaseProviderError extends Error {
  override readonly name = "DatabaseProviderError";
  readonly code: string;
  readonly retryable: boolean;
  override readonly cause: unknown;

  constructor(
    message: string,
    options: { readonly code: string; readonly retryable: boolean; readonly cause?: unknown },
  ) {
    super(message);
    this.code = options.code;
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
}

export class SecretStoreError extends Error {
  override readonly name = "SecretStoreError";
  readonly code: string;
  readonly retryable: boolean;
  override readonly cause: unknown;

  constructor(
    message: string,
    options: { readonly code: string; readonly retryable: boolean; readonly cause?: unknown },
  ) {
    super(message);
    this.code = options.code;
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
}

export class DatabaseMigrationError extends Error {
  override readonly name = "DatabaseMigrationError";
  readonly code = "DATABASE_MIGRATION_FAILED";
  readonly retryable = false;
  readonly step: string;
  readonly exitCode: number;

  constructor(step: string, exitCode: number) {
    super(`Database migration step ${step} exited with code ${String(exitCode)}`);
    this.step = step;
    this.exitCode = exitCode;
  }
}

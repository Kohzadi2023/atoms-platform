import type { JsonValue } from "@atoms/contracts";

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly statusCode: number;
  readonly code: string;
  readonly details: JsonValue | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: JsonValue,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class RepositoryConflictError extends Error {
  override readonly name = "RepositoryConflictError";
  readonly constraint: string;

  constructor(message: string, constraint: string) {
    super(message);
    this.constraint = constraint;
  }
}

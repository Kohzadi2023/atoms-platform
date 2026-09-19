export type AgentRuntimeErrorCode =
  | "INVALID_AGENT_OUTPUT"
  | "MODEL_RESPONSE_INCOMPLETE"
  | "REFERENCES_NOT_ACCEPTED";

export class AgentRuntimeError extends Error {
  override readonly name = "AgentRuntimeError";
  readonly code: AgentRuntimeErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      readonly code: AgentRuntimeErrorCode;
      readonly retryable: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

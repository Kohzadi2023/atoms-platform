export const MODEL_POLICIES = [
  "flagship",
  "balanced",
  "fast",
  "fallback",
] as const;

export type ModelPolicy = (typeof MODEL_POLICIES)[number];

export type ModelReference =
  | {
      readonly kind: "file";
      readonly fileName: string;
      readonly mimeType: "application/pdf" | "text/plain";
      readonly dataBase64: string;
    }
  | {
      readonly kind: "image";
      readonly fileName: string;
      readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
      readonly dataBase64: string;
      readonly detail?: "auto" | "low" | "high";
    };

export interface ModelRequest {
  readonly policy: ModelPolicy;
  readonly input: string;
  readonly references?: readonly ModelReference[];
  readonly instructions?: string;
  readonly maxOutputTokens?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ModelPricing {
  /** USD per one million non-cached input tokens. */
  readonly inputUsdPerMillionTokens: number;
  /** USD per one million output tokens. */
  readonly outputUsdPerMillionTokens: number;
  /** Defaults to the regular input rate when omitted. */
  readonly cachedInputUsdPerMillionTokens?: number;
}

export interface ModelUsageMetadata {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  /** Integer micro-USD estimate, present only when pricing was configured. */
  readonly estimatedCostUsdMicros?: number;
}

export type ModelResponseStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "in_progress"
  | "incomplete"
  | "queued";

export interface ModelResponse {
  readonly id: string;
  readonly provider: "openai";
  readonly policy: ModelPolicy;
  readonly model: string;
  readonly status: ModelResponseStatus;
  readonly outputText: string;
  readonly createdAt: string;
  readonly latencyMs: number;
  readonly usage: ModelUsageMetadata;
  readonly incompleteReason?: string;
}

export type ModelStreamEvent =
  | {
      readonly type: "text_delta";
      readonly delta: string;
      readonly providerSequence: number;
    }
  | {
      readonly type: "completed";
      readonly response: ModelResponse;
      readonly providerSequence: number;
    };

export interface ModelGateway {
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

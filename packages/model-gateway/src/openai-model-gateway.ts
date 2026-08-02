import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseUsage,
} from "openai/resources/responses/responses";

import { ModelGatewayError, normalizeOpenAIError } from "./errors.js";
import type {
  ModelGateway,
  ModelPolicy,
  ModelPricing,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelUsageMetadata,
} from "./types.js";

const DEFAULT_MODEL_ROUTES: Readonly<Record<ModelPolicy, string>> = {
  flagship: "gpt-4o",
  balanced: "gpt-4o",
  fast: "gpt-4o-mini",
  fallback: "gpt-4o-mini",
};

export type OpenAIClient = Pick<OpenAI, "responses">;

export interface OpenAIModelGatewayOptions {
  readonly apiKey?: string;
  readonly client?: OpenAIClient;
  readonly models?: Partial<Readonly<Record<ModelPolicy, string>>>;
  readonly pricing?: Readonly<Record<string, ModelPricing>>;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

export class OpenAIModelGateway implements ModelGateway {
  readonly #client: OpenAIClient;
  readonly #models: Readonly<Record<ModelPolicy, string>>;
  readonly #pricing: Readonly<Record<string, ModelPricing>>;

  constructor(options: OpenAIModelGatewayOptions = {}) {
    this.#client =
      options.client ??
      new OpenAI({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.maxRetries === undefined
          ? {}
          : { maxRetries: options.maxRetries }),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeout: options.timeoutMs }),
      });
    this.#models = { ...DEFAULT_MODEL_ROUTES, ...options.models };
    this.#pricing = options.pricing ?? {};
  }

  resolveModel(policy: ModelPolicy): string {
    return this.#models[policy];
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const model = this.resolveModel(request.policy);
    const startedAt = performance.now();

    try {
      const response = await this.#client.responses.create(
        this.#createParams(request, model),
      );
      return this.#mapResponse(
        response,
        request.policy,
        model,
        performance.now() - startedAt,
      );
    } catch (error) {
      throw normalizeOpenAIError(error);
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const model = this.resolveModel(request.policy);
    const startedAt = performance.now();

    try {
      const params: ResponseCreateParamsStreaming = {
        ...this.#createParams(request, model),
        stream: true,
      };
      const stream = await this.#client.responses.create(params);

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          yield {
            type: "text_delta",
            delta: event.delta,
            providerSequence: event.sequence_number,
          };
          continue;
        }

        if (event.type === "response.completed") {
          yield {
            type: "completed",
            response: this.#mapResponse(
              event.response,
              request.policy,
              model,
              performance.now() - startedAt,
            ),
            providerSequence: event.sequence_number,
          };
          continue;
        }

        if (event.type === "error") {
          throw new ModelGatewayError(event.message, {
            code: event.code === "rate_limit_exceeded" ? "RATE_LIMITED" : "PROVIDER_ERROR",
            retryable: event.code === "rate_limit_exceeded" || event.code === "server_error",
          });
        }

        if (event.type === "response.failed" || event.type === "response.incomplete") {
          throw new ModelGatewayError(
            event.response.error?.message ??
              event.response.incomplete_details?.reason ??
              "OpenAI response did not complete",
            {
              code: "RESPONSE_FAILED",
              retryable: event.type === "response.failed",
            },
          );
        }
      }
    } catch (error) {
      throw normalizeOpenAIError(error);
    }
  }

  #createParams(
    request: ModelRequest,
    model: string,
  ): ResponseCreateParamsNonStreaming {
    return {
      model,
      input: request.input,
      store: false,
      ...(request.instructions === undefined
        ? {}
        : { instructions: request.instructions }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: request.maxOutputTokens }),
      ...(request.metadata === undefined
        ? {}
        : { metadata: { ...request.metadata } }),
    };
  }

  #mapResponse(
    response: Response,
    policy: ModelPolicy,
    routedModel: string,
    latencyMs: number,
  ): ModelResponse {
    const model = response.model ?? routedModel;
    const usage = this.#mapUsage(response.usage, model);
    const incompleteReason = response.incomplete_details?.reason;

    return {
      id: response.id,
      provider: "openai",
      policy,
      model,
      status: response.status ?? "completed",
      outputText: response.output_text,
      createdAt: new Date(response.created_at * 1_000).toISOString(),
      latencyMs: Math.max(0, Math.round(latencyMs)),
      usage,
      ...(incompleteReason === undefined
        ? {}
        : { incompleteReason }),
    };
  }

  #mapUsage(
    usage: ResponseUsage | undefined,
    model: string,
  ): ModelUsageMetadata {
    const inputTokens = usage?.input_tokens ?? 0;
    const cachedInputTokens = usage?.input_tokens_details.cached_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    const reasoningTokens = usage?.output_tokens_details.reasoning_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens;
    const pricing = this.#pricing[model];

    return {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      ...(pricing === undefined
        ? {}
        : {
            estimatedCostUsdMicros: calculateCostUsdMicros(
              inputTokens,
              cachedInputTokens,
              outputTokens,
              pricing,
            ),
          }),
    };
  }
}

export function calculateCostUsdMicros(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  const safeCachedTokens = Math.min(
    Math.max(0, cachedInputTokens),
    Math.max(0, inputTokens),
  );
  const uncachedInputTokens = Math.max(0, inputTokens - safeCachedTokens);
  const cachedInputRate =
    pricing.cachedInputUsdPerMillionTokens ??
    pricing.inputUsdPerMillionTokens;

  // tokens × USD-per-million-token equals micro-USD directly.
  return Math.max(
    0,
    Math.round(
      uncachedInputTokens * pricing.inputUsdPerMillionTokens +
        safeCachedTokens * cachedInputRate +
        Math.max(0, outputTokens) * pricing.outputUsdPerMillionTokens,
    ),
  );
}


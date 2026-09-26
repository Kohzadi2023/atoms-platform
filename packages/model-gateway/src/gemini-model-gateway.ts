import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { CompletionUsage } from "openai/resources/completions";

import { ModelGatewayError, normalizeOpenAIError } from "./errors.js";
import type {
  ModelGateway,
  ModelPolicy,
  ModelPricing,
  ModelRequest,
  ModelResponse,
  ModelResponseStatus,
  ModelStreamEvent,
  ModelUsageMetadata,
} from "./types.js";

/**
 * Google's Gemini API exposes an OpenAI-compatibility layer at the Chat
 * Completions shape (not the newer Responses API OpenAIModelGateway uses --
 * Google does not implement that one). Reusing the `openai` SDK against this
 * base URL, rather than adding a second provider SDK, means error handling
 * (normalizeOpenAIError matches on `instanceof APIError`, a class this SDK
 * still throws regardless of which base URL it was pointed at) and the
 * request/response plumbing are shared with the OpenAI gateway almost
 * entirely; only the wire format (chat.completions vs responses) differs.
 */
const GEMINI_OPENAI_COMPAT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";

// Model names as of this gateway's introduction (2026-09-24); Google renames
// and retires models over time, so an operator overriding `models` in
// GeminiModelGatewayOptions is expected, not a workaround.
const DEFAULT_MODEL_ROUTES: Readonly<Record<ModelPolicy, string>> = {
  flagship: "gemini-2.5-pro",
  balanced: "gemini-2.5-flash",
  fast: "gemini-2.5-flash",
  fallback: "gemini-2.0-flash",
};

export type GeminiClient = Pick<OpenAI, "chat">;

export interface GeminiModelGatewayOptions {
  readonly apiKey?: string;
  readonly client?: GeminiClient;
  readonly models?: Partial<Readonly<Record<ModelPolicy, string>>>;
  readonly pricing?: Readonly<Record<string, ModelPricing>>;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

export class GeminiModelGateway implements ModelGateway {
  readonly #client: GeminiClient;
  readonly #models: Readonly<Record<ModelPolicy, string>>;
  readonly #pricing: Readonly<Record<string, ModelPricing>>;

  constructor(options: GeminiModelGatewayOptions = {}) {
    this.#client =
      options.client ??
      new OpenAI({
        baseURL: GEMINI_OPENAI_COMPAT_BASE_URL,
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
      const response = await this.#client.chat.completions.create(
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
      const params: ChatCompletionCreateParamsStreaming = {
        ...this.#createParams(request, model),
        stream: true,
        stream_options: { include_usage: true },
      };
      const stream = await this.#client.chat.completions.create(params);

      let sequence = 0;
      let id = "";
      let created = Math.floor(Date.now() / 1_000);
      let accumulated = "";
      let finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] | null = null;
      let usage: CompletionUsage | undefined;

      for await (const chunk of stream) {
        id = chunk.id || id;
        created = chunk.created ?? created;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices[0];
        if (choice?.delta.content) {
          accumulated += choice.delta.content;
          yield {
            type: "text_delta",
            delta: choice.delta.content,
            providerSequence: sequence,
          };
          sequence += 1;
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }

      yield {
        type: "completed",
        response: this.#buildResponse({
          id: id || `gemini_${String(Date.now())}`,
          policy: request.policy,
          model,
          outputText: accumulated,
          created,
          finishReason,
          usage,
          latencyMs: performance.now() - startedAt,
        }),
        providerSequence: sequence,
      };
    } catch (error) {
      throw normalizeOpenAIError(error);
    }
  }

  #createParams(
    request: ModelRequest,
    model: string,
  ): ChatCompletionCreateParamsNonStreaming {
    const content: ChatCompletionContentPart[] = [
      { type: "text", text: request.input },
    ];
    for (const reference of request.references ?? []) {
      if (reference.kind === "image") {
        content.push({
          type: "image_url",
          image_url: {
            url: `data:${reference.mimeType};base64,${reference.dataBase64}`,
            ...(reference.detail === undefined ? {} : { detail: reference.detail }),
          },
        });
        continue;
      }
      if (reference.mimeType !== "text/plain") {
        // Reachable only if something calls this gateway directly, bypassing
        // BudgetedModelGateway's own PDF/image rejection under budgeted
        // execution -- fail closed rather than silently dropping content.
        throw new ModelGatewayError(
          `references with mimeType ${reference.mimeType} are not supported by the Gemini gateway`,
          { code: "INVALID_REQUEST", retryable: false },
        );
      }
      const text = Buffer.from(reference.dataBase64, "base64").toString("utf8");
      content.push({ type: "text", text: `\n\n[Reference: ${reference.fileName}]\n${text}` });
    }

    const messages: ChatCompletionMessageParam[] = [];
    if (request.instructions !== undefined) {
      messages.push({ role: "system", content: request.instructions });
    }
    messages.push({ role: "user", content });

    return {
      model,
      messages,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { max_tokens: request.maxOutputTokens }),
    };
  }

  #mapResponse(
    response: ChatCompletion,
    policy: ModelPolicy,
    routedModel: string,
    latencyMs: number,
  ): ModelResponse {
    const choice = response.choices[0];
    return this.#buildResponse({
      id: response.id,
      policy,
      model: response.model || routedModel,
      outputText: choice?.message.content ?? "",
      created: response.created,
      finishReason: choice?.finish_reason ?? null,
      usage: response.usage,
      latencyMs,
    });
  }

  #buildResponse(input: {
    readonly id: string;
    readonly policy: ModelPolicy;
    readonly model: string;
    readonly outputText: string;
    readonly created: number;
    readonly finishReason: string | null;
    readonly usage: CompletionUsage | undefined;
    readonly latencyMs: number;
  }): ModelResponse {
    const { status, incompleteReason } = mapFinishReason(input.finishReason);
    return {
      id: input.id,
      provider: "google",
      policy: input.policy,
      model: input.model,
      status,
      outputText: input.outputText,
      createdAt: new Date(input.created * 1_000).toISOString(),
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      usage: this.#mapUsage(input.usage, input.model),
      ...(incompleteReason === undefined ? {} : { incompleteReason }),
    };
  }

  #mapUsage(usage: CompletionUsage | undefined, model: string): ModelUsageMetadata {
    const inputTokens = usage?.prompt_tokens ?? 0;
    const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
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
            estimatedCostUsdMicros: calculateGeminiCostUsdMicros(
              inputTokens,
              cachedInputTokens,
              outputTokens,
              pricing,
            ),
          }),
    };
  }
}

function mapFinishReason(
  finishReason: string | null,
): { readonly status: ModelResponseStatus; readonly incompleteReason?: string } {
  if (finishReason === null) return { status: "in_progress" };
  if (finishReason === "stop" || finishReason === "tool_calls" || finishReason === "function_call") {
    return { status: "completed" };
  }
  if (finishReason === "length") {
    return { status: "incomplete", incompleteReason: "max_output_tokens" };
  }
  if (finishReason === "content_filter") {
    return { status: "incomplete", incompleteReason: "content_filter" };
  }
  return { status: "completed" };
}

/** Same arithmetic as calculateCostUsdMicros in openai-model-gateway.ts, kept
 *  as its own copy rather than a shared import so each gateway's pricing
 *  logic can be audited without cross-referencing the other provider. */
export function calculateGeminiCostUsdMicros(
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
    pricing.cachedInputUsdPerMillionTokens ?? pricing.inputUsdPerMillionTokens;

  return Math.max(
    0,
    Math.round(
      uncachedInputTokens * pricing.inputUsdPerMillionTokens +
        safeCachedTokens * cachedInputRate +
        Math.max(0, outputTokens) * pricing.outputUsdPerMillionTokens,
    ),
  );
}

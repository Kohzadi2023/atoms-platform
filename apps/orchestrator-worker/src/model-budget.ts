import {
  calculateCostUsdMicros,
  type ModelGateway,
  type ModelPolicy,
  type ModelPricing,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from "@atoms/model-gateway";
import Redis from "ioredis";

const REQUEST_OVERHEAD_TOKEN_RESERVE = 2_048;
const DEFAULT_BUDGET_TTL_MS = 24 * 60 * 60 * 1_000;

export const PINNED_OPENAI_MODELS: Readonly<Record<ModelPolicy, string>> = {
  flagship: "gpt-4o-2024-11-20",
  balanced: "gpt-4o-2024-11-20",
  fast: "gpt-4o-mini-2024-07-18",
  fallback: "gpt-4o-mini-2024-07-18",
};

// Verified against the OpenAI model documentation on 2026-09-10.
// The budget layer applies an additional configurable safety multiplier before
// reserving spend, so reservations remain conservative relative to these rates.
export const PINNED_OPENAI_PRICING: Readonly<Record<string, ModelPricing>> = {
  "gpt-4o-2024-11-20": {
    inputUsdPerMillionTokens: 2.5,
    cachedInputUsdPerMillionTokens: 1.25,
    outputUsdPerMillionTokens: 10,
  },
  "gpt-4o-mini-2024-07-18": {
    inputUsdPerMillionTokens: 0.15,
    cachedInputUsdPerMillionTokens: 0.075,
    outputUsdPerMillionTokens: 0.6,
  },
};

export const PINNED_OPENAI_OUTPUT_LIMITS: Readonly<Record<string, number>> = {
  "gpt-4o-2024-11-20": 16_384,
  "gpt-4o-mini-2024-07-18": 16_384,
};

export class ProviderBudgetError extends Error {
  override readonly name = "ProviderBudgetError";
  readonly retryable = false;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RunProviderBudgetStore {
  reserve(input: {
    readonly runId: string;
    readonly reservationUsdMicros: number;
    readonly totalBudgetUsdMicros: number;
    readonly ttlMs: number;
  }): Promise<{ readonly accepted: boolean; readonly remainingUsdMicros: number }>;
}

export interface RoutedModelGateway extends ModelGateway {
  resolveModel(policy: ModelPolicy): string;
}

export interface BudgetedModelGatewayOptions {
  readonly gateway: RoutedModelGateway;
  readonly budgetStore: RunProviderBudgetStore;
  readonly totalBudgetUsdMicros: number;
  readonly pricing: Readonly<Record<string, ModelPricing>>;
  readonly outputTokenLimits: Readonly<Record<string, number>>;
  readonly safetyMultiplier?: number;
  readonly budgetTtlMs?: number;
}

export class BudgetedModelGateway implements ModelGateway {
  readonly #gateway: RoutedModelGateway;
  readonly #budgetStore: RunProviderBudgetStore;
  readonly #totalBudgetUsdMicros: number;
  readonly #pricing: Readonly<Record<string, ModelPricing>>;
  readonly #outputTokenLimits: Readonly<Record<string, number>>;
  readonly #safetyMultiplier: number;
  readonly #budgetTtlMs: number;

  constructor(options: BudgetedModelGatewayOptions) {
    if (!Number.isInteger(options.totalBudgetUsdMicros) || options.totalBudgetUsdMicros < 0) {
      throw new RangeError("totalBudgetUsdMicros must be a non-negative integer");
    }
    const safetyMultiplier = options.safetyMultiplier ?? 1.5;
    if (!Number.isFinite(safetyMultiplier) || safetyMultiplier < 1 || safetyMultiplier > 10) {
      throw new RangeError("safetyMultiplier must be between 1 and 10");
    }
    const budgetTtlMs = options.budgetTtlMs ?? DEFAULT_BUDGET_TTL_MS;
    if (!Number.isInteger(budgetTtlMs) || budgetTtlMs < 60_000) {
      throw new RangeError("budgetTtlMs must be at least 60000");
    }

    this.#gateway = options.gateway;
    this.#budgetStore = options.budgetStore;
    this.#totalBudgetUsdMicros = options.totalBudgetUsdMicros;
    this.#pricing = options.pricing;
    this.#outputTokenLimits = options.outputTokenLimits;
    this.#safetyMultiplier = safetyMultiplier;
    this.#budgetTtlMs = budgetTtlMs;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    await this.#reserve(request);
    return this.#gateway.generate(request);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    await this.#reserve(request);
    for await (const event of this.#gateway.stream(request)) {
      yield event;
    }
  }

  async #reserve(request: ModelRequest): Promise<void> {
    if (this.#totalBudgetUsdMicros === 0) {
      throw new ProviderBudgetError(
        "PROVIDER_BUDGET_DISABLED",
        "Provider execution is disabled because no per-run provider budget is configured",
      );
    }

    const runId = request.metadata?.run_id?.trim();
    if (runId === undefined || runId.length === 0) {
      throw new ProviderBudgetError(
        "PROVIDER_BUDGET_CONTEXT_MISSING",
        "Provider calls require a run_id budget context",
      );
    }

    const reservationUsdMicros = estimateTextRequestReservationUsdMicros({
      request,
      model: this.#gateway.resolveModel(request.policy),
      pricing: this.#pricing,
      outputTokenLimits: this.#outputTokenLimits,
      safetyMultiplier: this.#safetyMultiplier,
    });

    const reservation = await this.#budgetStore.reserve({
      runId,
      reservationUsdMicros,
      totalBudgetUsdMicros: this.#totalBudgetUsdMicros,
      ttlMs: this.#budgetTtlMs,
    });

    if (!reservation.accepted) {
      throw new ProviderBudgetError(
        "PROVIDER_BUDGET_EXCEEDED",
        `Provider request reservation ${String(reservationUsdMicros)} micro-USD exceeds remaining run budget ${String(reservation.remainingUsdMicros)} micro-USD`,
      );
    }
  }
}

export function estimateTextRequestReservationUsdMicros(input: {
  readonly request: ModelRequest;
  readonly model: string;
  readonly pricing: Readonly<Record<string, ModelPricing>>;
  readonly outputTokenLimits: Readonly<Record<string, number>>;
  readonly safetyMultiplier: number;
}): number {
  if (input.request.references !== undefined && input.request.references.length > 0) {
    throw new ProviderBudgetError(
      "PROVIDER_BUDGET_REFERENCES_UNSUPPORTED",
      "Budgeted provider execution currently rejects file/image references because their provider token cost cannot be bounded safely before the call",
    );
  }

  const maxOutputTokens = input.request.maxOutputTokens;
  if (maxOutputTokens === undefined || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new ProviderBudgetError(
      "PROVIDER_BUDGET_OUTPUT_LIMIT_REQUIRED",
      "Budgeted provider calls require an explicit positive maxOutputTokens value",
    );
  }

  const outputLimit = input.outputTokenLimits[input.model];
  if (outputLimit === undefined) {
    throw new ProviderBudgetError(
      "PROVIDER_MODEL_NOT_BUDGETED",
      `Model ${input.model} has no approved output-token limit`,
    );
  }
  if (maxOutputTokens > outputLimit) {
    throw new ProviderBudgetError(
      "PROVIDER_OUTPUT_LIMIT_EXCEEDED",
      `Requested maxOutputTokens ${String(maxOutputTokens)} exceeds approved model limit ${String(outputLimit)} for ${input.model}`,
    );
  }

  const pricing = input.pricing[input.model];
  if (pricing === undefined) {
    throw new ProviderBudgetError(
      "PROVIDER_MODEL_NOT_BUDGETED",
      `Model ${input.model} has no approved pricing configuration`,
    );
  }

  if (!Number.isFinite(input.safetyMultiplier) || input.safetyMultiplier < 1) {
    throw new RangeError("safetyMultiplier must be at least 1");
  }

  // OpenAI text tokenization is byte based; UTF-8 byte length therefore gives
  // a conservative upper bound for text token count. Add a fixed reserve for
  // request framing/protocol overhead, then apply the configured safety factor.
  const textBytes =
    Buffer.byteLength(input.request.input, "utf8") +
    Buffer.byteLength(input.request.instructions ?? "", "utf8");
  const inputTokenUpperBound = textBytes + REQUEST_OVERHEAD_TOKEN_RESERVE;
  const rawUsdMicros = calculateCostUsdMicros(
    inputTokenUpperBound,
    0,
    maxOutputTokens,
    pricing,
  );

  return Math.max(1, Math.ceil(rawUsdMicros * input.safetyMultiplier));
}

const RESERVE_BUDGET_LUA = `
local current = redis.call("GET", KEYS[1])
if not current then
  current = tonumber(ARGV[1])
else
  current = tonumber(current)
end
local reservation = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if reservation > current then
  return {0, current}
end
local remaining = current - reservation
redis.call("SET", KEYS[1], remaining, "PX", ttl)
return {1, remaining}
`;

export class RedisRunProviderBudgetStore implements RunProviderBudgetStore {
  readonly #redis: Redis;
  readonly #keyPrefix: string;

  constructor(options: { readonly redisUrl: string; readonly keyPrefix?: string }) {
    this.#redis = new Redis(options.redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    this.#keyPrefix = options.keyPrefix ?? "atoms:provider-budget";
  }

  async reserve(input: {
    readonly runId: string;
    readonly reservationUsdMicros: number;
    readonly totalBudgetUsdMicros: number;
    readonly ttlMs: number;
  }): Promise<{ readonly accepted: boolean; readonly remainingUsdMicros: number }> {
    for (const [name, value] of [
      ["reservationUsdMicros", input.reservationUsdMicros],
      ["totalBudgetUsdMicros", input.totalBudgetUsdMicros],
      ["ttlMs", input.ttlMs],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative integer`);
      }
    }
    if (input.runId.trim().length === 0) {
      throw new TypeError("runId must not be empty");
    }

    const result = await this.#redis.eval(
      RESERVE_BUDGET_LUA,
      1,
      `${this.#keyPrefix}:${input.runId}`,
      String(input.totalBudgetUsdMicros),
      String(input.reservationUsdMicros),
      String(input.ttlMs),
    );

    if (!Array.isArray(result) || result.length !== 2) {
      throw new Error("Redis provider budget reservation returned an invalid response");
    }
    const accepted = Number(result[0]) === 1;
    const remainingUsdMicros = Number(result[1]);
    if (!Number.isSafeInteger(remainingUsdMicros) || remainingUsdMicros < 0) {
      throw new Error("Redis provider budget reservation returned an invalid balance");
    }
    return { accepted, remainingUsdMicros };
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }
}

import {
  calculateCostUsdMicros,
  type ModelGateway,
  type ModelPolicy,
  type ModelPricing,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from "@atoms/model-gateway";
import type { PrismaClient } from "@atoms/db";

const REQUEST_OVERHEAD_TOKEN_RESERVE = 2_048;
const STANDARD_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

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
}

export class BudgetedModelGateway implements ModelGateway {
  readonly #gateway: RoutedModelGateway;
  readonly #budgetStore: RunProviderBudgetStore;
  readonly #totalBudgetUsdMicros: number;
  readonly #pricing: Readonly<Record<string, ModelPricing>>;
  readonly #outputTokenLimits: Readonly<Record<string, number>>;
  readonly #safetyMultiplier: number;

  constructor(options: BudgetedModelGatewayOptions) {
    if (
      !Number.isInteger(options.totalBudgetUsdMicros) ||
      options.totalBudgetUsdMicros < 0
    ) {
      throw new RangeError("totalBudgetUsdMicros must be a non-negative integer");
    }
    const safetyMultiplier = options.safetyMultiplier ?? 1.5;
    if (
      !Number.isFinite(safetyMultiplier) ||
      safetyMultiplier < 1 ||
      safetyMultiplier > 10
    ) {
      throw new RangeError("safetyMultiplier must be between 1 and 10");
    }

    this.#gateway = options.gateway;
    this.#budgetStore = options.budgetStore;
    this.#totalBudgetUsdMicros = options.totalBudgetUsdMicros;
    this.#pricing = options.pricing;
    this.#outputTokenLimits = options.outputTokenLimits;
    this.#safetyMultiplier = safetyMultiplier;
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
  const maxOutputTokens = input.request.maxOutputTokens;
  if (
    maxOutputTokens === undefined ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 1
  ) {
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

  const referenceBytes = boundedTextReferenceBytes(input.request);

  // OpenAI text tokenization is byte based; UTF-8 byte length therefore gives
  // a conservative upper bound for text token count. Include decoded text
  // reference bytes, add protocol/framing reserve, then apply the configured
  // safety multiplier. PDF/image references remain fail-closed below because
  // their provider token cost cannot be bounded reliably from file bytes alone.
  const textBytes =
    Buffer.byteLength(input.request.input, "utf8") +
    Buffer.byteLength(input.request.instructions ?? "", "utf8") +
    referenceBytes;
  const inputTokenUpperBound = textBytes + REQUEST_OVERHEAD_TOKEN_RESERVE;
  const rawUsdMicros = calculateCostUsdMicros(
    inputTokenUpperBound,
    0,
    maxOutputTokens,
    pricing,
  );

  return Math.max(1, Math.ceil(rawUsdMicros * input.safetyMultiplier));
}

function boundedTextReferenceBytes(request: ModelRequest): number {
  let bytes = 0;
  for (const reference of request.references ?? []) {
    if (reference.kind !== "file" || reference.mimeType !== "text/plain") {
      throw new ProviderBudgetError(
        "PROVIDER_BUDGET_REFERENCES_UNSUPPORTED",
        "Budgeted provider execution currently permits only UTF-8 text/plain references; PDF and image references remain disabled",
      );
    }

    if (!STANDARD_BASE64_PATTERN.test(reference.dataBase64)) {
      throw new ProviderBudgetError(
        "PROVIDER_BUDGET_REFERENCE_INVALID",
        `Text reference ${reference.fileName} is not canonical base64`,
      );
    }

    const decoded = Buffer.from(reference.dataBase64, "base64");
    const decodedText = decoded.toString("utf8");
    if (!Buffer.from(decodedText, "utf8").equals(decoded)) {
      throw new ProviderBudgetError(
        "PROVIDER_BUDGET_REFERENCE_INVALID",
        `Text reference ${reference.fileName} is not valid UTF-8`,
      );
    }
    bytes += decoded.byteLength;
  }
  return bytes;
}

interface ProviderBudgetRow {
  readonly totalUsdMicros: number;
  readonly reservedUsdMicros: number;
}

export class PostgresRunProviderBudgetStore implements RunProviderBudgetStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async reserve(input: {
    readonly runId: string;
    readonly reservationUsdMicros: number;
    readonly totalBudgetUsdMicros: number;
  }): Promise<{ readonly accepted: boolean; readonly remainingUsdMicros: number }> {
    if (!Number.isInteger(input.reservationUsdMicros) || input.reservationUsdMicros <= 0) {
      throw new RangeError("reservationUsdMicros must be a positive integer");
    }
    if (!Number.isInteger(input.totalBudgetUsdMicros) || input.totalBudgetUsdMicros <= 0) {
      throw new RangeError("totalBudgetUsdMicros must be a positive integer");
    }
    if (input.runId.trim().length === 0) {
      throw new TypeError("runId must not be empty");
    }

    return this.#prisma.$transaction(async (transaction) => {
      // First reservation permanently fixes the durable ceiling for this run.
      // ON CONFLICT never raises an existing ceiling. A lower later deployment
      // is honored through Math.min below, so configuration can only tighten it.
      await transaction.$executeRaw`
        INSERT INTO atoms_runtime.run_provider_budgets (
          run_id,
          total_usd_micros,
          reserved_usd_micros
        )
        VALUES (
          ${input.runId}::uuid,
          ${input.totalBudgetUsdMicros},
          0
        )
        ON CONFLICT (run_id) DO NOTHING
      `;

      const rows = await transaction.$queryRaw<ProviderBudgetRow[]>`
        SELECT
          total_usd_micros AS "totalUsdMicros",
          reserved_usd_micros AS "reservedUsdMicros"
        FROM atoms_runtime.run_provider_budgets
        WHERE run_id = ${input.runId}::uuid
        FOR UPDATE
      `;
      const current = rows[0];
      if (current === undefined) {
        throw new Error("Provider budget ledger row could not be initialized");
      }

      const effectiveTotalUsdMicros = Math.min(
        current.totalUsdMicros,
        input.totalBudgetUsdMicros,
      );
      const remainingUsdMicros = Math.max(
        0,
        effectiveTotalUsdMicros - current.reservedUsdMicros,
      );
      if (input.reservationUsdMicros > remainingUsdMicros) {
        return { accepted: false, remainingUsdMicros };
      }

      await transaction.$executeRaw`
        UPDATE atoms_runtime.run_provider_budgets
        SET
          reserved_usd_micros = reserved_usd_micros + ${input.reservationUsdMicros},
          updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ${input.runId}::uuid
      `;

      return {
        accepted: true,
        remainingUsdMicros: remainingUsdMicros - input.reservationUsdMicros,
      };
    });
  }
}

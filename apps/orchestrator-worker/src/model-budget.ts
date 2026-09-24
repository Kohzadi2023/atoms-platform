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

export const PINNED_GEMINI_MODELS: Readonly<Record<ModelPolicy, string>> = {
  flagship: "gemini-2.5-pro",
  balanced: "gemini-2.5-flash",
  fast: "gemini-2.5-flash",
  fallback: "gemini-2.0-flash",
};

// Approximate, rounded UP from Google's published Gemini API pricing as of
// 2026-09-24 -- deliberately conservative (this is the same table the
// pre-call reservation in reserveConservativeCostUsdMicros uses, not only
// response telemetry, so an underestimate here would under-reserve). Verify
// the current rates at ai.google.dev/pricing before relying on this for real
// spend beyond a small, capped pilot: RUN_PROVIDER_BUDGET_USD_MICROS and
// WORKSPACE_PROVIDER_BUDGET_USD_MICROS_PER_DAY are the actual hard ceilings
// regardless of how accurate this table is.
export const PINNED_GEMINI_PRICING: Readonly<Record<string, ModelPricing>> = {
  "gemini-2.5-pro": {
    inputUsdPerMillionTokens: 2.5,
    outputUsdPerMillionTokens: 15,
  },
  "gemini-2.5-flash": {
    inputUsdPerMillionTokens: 0.5,
    outputUsdPerMillionTokens: 3.5,
  },
  "gemini-2.0-flash": {
    inputUsdPerMillionTokens: 0.15,
    outputUsdPerMillionTokens: 0.6,
  },
};

export const PINNED_GEMINI_OUTPUT_LIMITS: Readonly<Record<string, number>> = {
  "gemini-2.5-pro": 8_192,
  "gemini-2.5-flash": 8_192,
  "gemini-2.0-flash": 8_192,
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

export type BudgetExhaustionScope = "run" | "workspace";

export interface BudgetReservationResult {
  readonly accepted: boolean;
  /** Remaining budget in the scope that was checked (or that rejected). */
  readonly remainingUsdMicros: number;
  /** Present only when `accepted` is false. */
  readonly exhausted?: BudgetExhaustionScope;
}

export interface RunProviderBudgetStore {
  reserve(input: {
    readonly runId: string;
    readonly reservationUsdMicros: number;
    readonly totalBudgetUsdMicros: number;
    /**
     * Per-workspace, per-UTC-day ceiling. Omitted only by callers that do
     * not enforce one (tests); the worker refuses to start with a per-run
     * budget and no workspace ceiling.
     */
    readonly workspaceDailyBudgetUsdMicros?: number;
  }): Promise<BudgetReservationResult>;

  /** Records what a completed provider call actually cost. Telemetry only. */
  recordActual(input: {
    readonly runId: string;
    readonly actualUsdMicros: number;
  }): Promise<void>;
}

export interface RoutedModelGateway extends ModelGateway {
  resolveModel(policy: ModelPolicy): string;
}

export interface BudgetedModelGatewayOptions {
  readonly gateway: RoutedModelGateway;
  readonly budgetStore: RunProviderBudgetStore;
  readonly totalBudgetUsdMicros: number;
  readonly workspaceDailyBudgetUsdMicros?: number;
  readonly pricing: Readonly<Record<string, ModelPricing>>;
  readonly outputTokenLimits: Readonly<Record<string, number>>;
  readonly safetyMultiplier?: number;
}

export class BudgetedModelGateway implements ModelGateway {
  readonly #gateway: RoutedModelGateway;
  readonly #budgetStore: RunProviderBudgetStore;
  readonly #totalBudgetUsdMicros: number;
  readonly #workspaceDailyBudgetUsdMicros: number | undefined;
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
    if (
      options.workspaceDailyBudgetUsdMicros !== undefined &&
      (!Number.isInteger(options.workspaceDailyBudgetUsdMicros) ||
        options.workspaceDailyBudgetUsdMicros < 1)
    ) {
      throw new RangeError(
        "workspaceDailyBudgetUsdMicros must be a positive integer when provided",
      );
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
    this.#workspaceDailyBudgetUsdMicros = options.workspaceDailyBudgetUsdMicros;
    this.#pricing = options.pricing;
    this.#outputTokenLimits = options.outputTokenLimits;
    this.#safetyMultiplier = safetyMultiplier;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const runId = await this.#reserve(request);
    const response = await this.#gateway.generate(request);
    await this.#recordActual(runId, response);
    return response;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const runId = await this.#reserve(request);
    for await (const event of this.#gateway.stream(request)) {
      if (event.type === "completed") {
        await this.#recordActual(runId, event.response);
      }
      yield event;
    }
  }

  async #recordActual(runId: string, response: ModelResponse): Promise<void> {
    const actualUsdMicros = response.usage.estimatedCostUsdMicros;
    if (actualUsdMicros === undefined || actualUsdMicros < 0) return;
    try {
      await this.#budgetStore.recordActual({ runId, actualUsdMicros });
    } catch {
      // The provider call already happened and was paid for. Failing it here
      // would discard the response and trigger a retry that pays again. The
      // reservation that enforces the ceiling is unaffected, so the only
      // consequence of a lost write is a gap in reported actual cost.
    }
  }

  async #reserve(request: ModelRequest): Promise<string> {
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
      ...(this.#workspaceDailyBudgetUsdMicros === undefined
        ? {}
        : { workspaceDailyBudgetUsdMicros: this.#workspaceDailyBudgetUsdMicros }),
    });

    if (!reservation.accepted) {
      if (reservation.exhausted === "workspace") {
        throw new ProviderBudgetError(
          "WORKSPACE_BUDGET_EXCEEDED",
          `Provider request reservation ${String(reservationUsdMicros)} micro-USD exceeds the remaining daily workspace budget ${String(reservation.remainingUsdMicros)} micro-USD`,
        );
      }
      throw new ProviderBudgetError(
        "PROVIDER_BUDGET_EXCEEDED",
        `Provider request reservation ${String(reservationUsdMicros)} micro-USD exceeds remaining run budget ${String(reservation.remainingUsdMicros)} micro-USD`,
      );
    }
    return runId;
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

interface WorkspaceWindowRow {
  readonly reservedUsdMicros: number;
  readonly workspaceId: string;
  readonly windowDate: string;
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
    readonly workspaceDailyBudgetUsdMicros?: number;
  }): Promise<BudgetReservationResult> {
    if (!Number.isInteger(input.reservationUsdMicros) || input.reservationUsdMicros <= 0) {
      throw new RangeError("reservationUsdMicros must be a positive integer");
    }
    if (!Number.isInteger(input.totalBudgetUsdMicros) || input.totalBudgetUsdMicros <= 0) {
      throw new RangeError("totalBudgetUsdMicros must be a positive integer");
    }
    const workspaceCap = input.workspaceDailyBudgetUsdMicros;
    if (
      workspaceCap !== undefined &&
      (!Number.isInteger(workspaceCap) || workspaceCap <= 0)
    ) {
      throw new RangeError("workspaceDailyBudgetUsdMicros must be a positive integer");
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

      // Lock order is always run row first, then workspace-window row, so two
      // runs of one workspace serialize on the window without deadlocking.
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
        return { accepted: false, remainingUsdMicros, exhausted: "run" as const };
      }

      if (workspaceCap !== undefined) {
        await transaction.$executeRaw`
          INSERT INTO atoms_runtime.workspace_provider_budget_windows (
            workspace_id,
            window_date,
            reserved_usd_micros
          )
          SELECT
            run.workspace_id,
            (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,
            0
          FROM public.agent_runs AS run
          WHERE run.id = ${input.runId}::uuid
          ON CONFLICT (workspace_id, window_date) DO NOTHING
        `;
        const windows = await transaction.$queryRaw<WorkspaceWindowRow[]>`
          SELECT
            window_row.reserved_usd_micros AS "reservedUsdMicros",
            window_row.workspace_id::text AS "workspaceId",
            window_row.window_date::text AS "windowDate"
          FROM atoms_runtime.workspace_provider_budget_windows AS window_row
          JOIN public.agent_runs AS run
            ON run.workspace_id = window_row.workspace_id
          WHERE run.id = ${input.runId}::uuid
            AND window_row.window_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
          FOR UPDATE OF window_row
        `;
        const window = windows[0];
        if (window === undefined) {
          throw new Error("Workspace budget window could not be initialized");
        }
        const windowRemaining = Math.max(0, workspaceCap - window.reservedUsdMicros);
        if (input.reservationUsdMicros > windowRemaining) {
          return {
            accepted: false,
            remainingUsdMicros: windowRemaining,
            exhausted: "workspace" as const,
          };
        }
        await transaction.$executeRaw`
          UPDATE atoms_runtime.workspace_provider_budget_windows
          SET
            reserved_usd_micros = reserved_usd_micros + ${input.reservationUsdMicros},
            updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = ${window.workspaceId}::uuid
            AND window_date = ${window.windowDate}::date
        `;
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

  async recordActual(input: {
    readonly runId: string;
    readonly actualUsdMicros: number;
  }): Promise<void> {
    if (!Number.isInteger(input.actualUsdMicros) || input.actualUsdMicros < 0) {
      throw new RangeError("actualUsdMicros must be a non-negative integer");
    }
    await this.#prisma.$executeRaw`
      UPDATE atoms_runtime.run_provider_budgets
      SET
        actual_usd_micros = actual_usd_micros + ${input.actualUsdMicros},
        updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ${input.runId}::uuid
    `;
  }
}

import assert from "node:assert/strict";
import test from "node:test";

import type {
  ModelPolicy,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "@atoms/model-gateway";

import {
  BudgetedModelGateway,
  PINNED_GEMINI_MODELS,
  PINNED_GEMINI_OUTPUT_LIMITS,
  PINNED_GEMINI_PRICING,
  PINNED_OPENAI_MODELS,
  PINNED_OPENAI_OUTPUT_LIMITS,
  PINNED_OPENAI_PRICING,
  ProviderBudgetError,
  estimateTextRequestReservationUsdMicros,
  type BudgetExhaustionScope,
  type BudgetReservationResult,
  type RoutedModelGateway,
  type RunProviderBudgetStore,
} from "./model-budget.js";

const MODEL = "gpt-4o-2024-11-20";
const RUN_ID = "00000000-0000-4000-8000-000000000001";

class FakeGateway implements RoutedModelGateway {
  generateCalls = 0;
  streamCalls = 0;

  resolveModel(_policy: ModelPolicy): string {
    return MODEL;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.generateCalls += 1;
    return {
      id: "response-1",
      provider: "openai",
      policy: request.policy,
      model: MODEL,
      status: "completed",
      outputText: "{}",
      createdAt: new Date(0).toISOString(),
      latencyMs: 1,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 2,
      },
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.streamCalls += 1;
    yield {
      type: "completed",
      providerSequence: 1,
      response: await this.generate(request),
    };
  }
}

class FakeBudgetStore implements RunProviderBudgetStore {
  calls: Array<{
    readonly runId: string;
    readonly reservationUsdMicros: number;
    readonly totalBudgetUsdMicros: number;
    readonly workspaceDailyBudgetUsdMicros?: number;
  }> = [];
  actuals: Array<{ readonly runId: string; readonly actualUsdMicros: number }> = [];
  accepted = true;
  exhausted: BudgetExhaustionScope | undefined;
  remainingUsdMicros = 1_000_000;
  failRecordActual = false;

  async reserve(input: {
    readonly runId: string;
    readonly reservationUsdMicros: number;
    readonly totalBudgetUsdMicros: number;
    readonly workspaceDailyBudgetUsdMicros?: number;
  }): Promise<BudgetReservationResult> {
    this.calls.push(input);
    return {
      accepted: this.accepted,
      remainingUsdMicros: this.remainingUsdMicros,
      ...(this.accepted || this.exhausted === undefined
        ? {}
        : { exhausted: this.exhausted }),
    };
  }

  async recordActual(input: {
    readonly runId: string;
    readonly actualUsdMicros: number;
  }): Promise<void> {
    if (this.failRecordActual) throw new Error("ledger unavailable");
    this.actuals.push(input);
  }
}

class PricedFakeGateway extends FakeGateway {
  override async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await super.generate(request);
    return {
      ...response,
      usage: { ...response.usage, estimatedCostUsdMicros: 4_321 },
    };
  }
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    policy: "flagship",
    input: "Build a small page",
    instructions: "Return JSON",
    maxOutputTokens: 1_000,
    metadata: { run_id: RUN_ID },
    ...overrides,
  };
}

function estimate(value: ModelRequest): number {
  return estimateTextRequestReservationUsdMicros({
    request: value,
    model: MODEL,
    pricing: PINNED_OPENAI_PRICING,
    outputTokenLimits: PINNED_OPENAI_OUTPUT_LIMITS,
    safetyMultiplier: 1.5,
  });
}

test("reserves a conservative run budget before the provider call", async () => {
  const gateway = new FakeGateway();
  const store = new FakeBudgetStore();
  const budgeted = new BudgetedModelGateway({
    gateway,
    budgetStore: store,
    totalBudgetUsdMicros: 2_000_000,
    pricing: PINNED_OPENAI_PRICING,
    outputTokenLimits: PINNED_OPENAI_OUTPUT_LIMITS,
    safetyMultiplier: 1.5,
  });

  const response = await budgeted.generate(request());

  assert.equal(response.status, "completed");
  assert.equal(gateway.generateCalls, 1);
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0]?.runId, RUN_ID);
  assert.equal(store.calls[0]?.totalBudgetUsdMicros, 2_000_000);
  assert.ok((store.calls[0]?.reservationUsdMicros ?? 0) > 0);
});

test("rejects an exhausted budget before invoking the provider", async () => {
  const gateway = new FakeGateway();
  const store = new FakeBudgetStore();
  store.accepted = false;
  store.remainingUsdMicros = 250;
  const budgeted = new BudgetedModelGateway({
    gateway,
    budgetStore: store,
    totalBudgetUsdMicros: 2_000_000,
    pricing: PINNED_OPENAI_PRICING,
    outputTokenLimits: PINNED_OPENAI_OUTPUT_LIMITS,
  });

  await assert.rejects(
    () => budgeted.generate(request()),
    (error: unknown) =>
      error instanceof ProviderBudgetError &&
      error.code === "PROVIDER_BUDGET_EXCEEDED" &&
      error.retryable === false,
  );
  assert.equal(gateway.generateCalls, 0);
});

test("zero configured budget fails closed before ledger or provider work", async () => {
  const gateway = new FakeGateway();
  const store = new FakeBudgetStore();
  const budgeted = new BudgetedModelGateway({
    gateway,
    budgetStore: store,
    totalBudgetUsdMicros: 0,
    pricing: PINNED_OPENAI_PRICING,
    outputTokenLimits: PINNED_OPENAI_OUTPUT_LIMITS,
  });

  await assert.rejects(
    () => budgeted.generate(request()),
    (error: unknown) =>
      error instanceof ProviderBudgetError &&
      error.code === "PROVIDER_BUDGET_DISABLED",
  );
  assert.equal(store.calls.length, 0);
  assert.equal(gateway.generateCalls, 0);
});

test("requires a run budget context", async () => {
  const gateway = new FakeGateway();
  const store = new FakeBudgetStore();
  const budgeted = new BudgetedModelGateway({
    gateway,
    budgetStore: store,
    totalBudgetUsdMicros: 2_000_000,
    pricing: PINNED_OPENAI_PRICING,
    outputTokenLimits: PINNED_OPENAI_OUTPUT_LIMITS,
  });

  await assert.rejects(
    () => budgeted.generate(request({ metadata: {} })),
    (error: unknown) =>
      error instanceof ProviderBudgetError &&
      error.code === "PROVIDER_BUDGET_CONTEXT_MISSING",
  );
  assert.equal(gateway.generateCalls, 0);
});

test("includes UTF-8 text reference bytes in the conservative reservation", () => {
  const withoutReference = estimate(request());
  const text = "This is bounded staging context.";
  const withReference = estimate(
    request({
      references: [
        {
          kind: "file",
          fileName: "context.txt",
          mimeType: "text/plain",
          dataBase64: Buffer.from(text, "utf8").toString("base64"),
        },
      ],
    }),
  );

  assert.ok(withReference > withoutReference);
});

test("rejects PDF and image references before provider work", () => {
  for (const references of [
    [
      {
        kind: "file" as const,
        fileName: "context.pdf",
        mimeType: "application/pdf" as const,
        dataBase64: "JVBERi0xLjQ=",
      },
    ],
    [
      {
        kind: "image" as const,
        fileName: "context.png",
        mimeType: "image/png" as const,
        dataBase64: "iVBORw0KGgo=",
      },
    ],
  ]) {
    assert.throws(
      () => estimate(request({ references })),
      (error: unknown) =>
        error instanceof ProviderBudgetError &&
        error.code === "PROVIDER_BUDGET_REFERENCES_UNSUPPORTED",
    );
  }
});

test("rejects malformed or non-UTF-8 text references", () => {
  for (const dataBase64 of ["not base64!", "/w=="]) {
    assert.throws(
      () =>
        estimate(
          request({
            references: [
              {
                kind: "file",
                fileName: "invalid.txt",
                mimeType: "text/plain",
                dataBase64,
              },
            ],
          }),
        ),
      (error: unknown) =>
        error instanceof ProviderBudgetError &&
        error.code === "PROVIDER_BUDGET_REFERENCE_INVALID",
    );
  }
});

test("rejects a model output request above the pinned provider limit", () => {
  assert.throws(
    () => estimate(request({ maxOutputTokens: 16_385 })),
    (error: unknown) =>
      error instanceof ProviderBudgetError &&
      error.code === "PROVIDER_OUTPUT_LIMIT_EXCEEDED",
  );
});

test("reserves the stream budget before the first provider stream event", async () => {
  const gateway = new FakeGateway();
  const store = new FakeBudgetStore();
  const budgeted = new BudgetedModelGateway({
    gateway,
    budgetStore: store,
    totalBudgetUsdMicros: 2_000_000,
    pricing: PINNED_OPENAI_PRICING,
    outputTokenLimits: PINNED_OPENAI_OUTPUT_LIMITS,
  });

  const events: ModelStreamEvent[] = [];
  for await (const event of budgeted.stream(request())) {
    events.push(event);
  }

  assert.equal(store.calls.length, 1);
  assert.equal(gateway.streamCalls, 1);
  assert.equal(events.length, 1);
});

function budgeted(
  gateway: RoutedModelGateway,
  store: RunProviderBudgetStore,
  workspaceDailyBudgetUsdMicros?: number,
): BudgetedModelGateway {
  return new BudgetedModelGateway({
    gateway,
    budgetStore: store,
    totalBudgetUsdMicros: 2_000_000,
    ...(workspaceDailyBudgetUsdMicros === undefined
      ? {}
      : { workspaceDailyBudgetUsdMicros }),
    pricing: PINNED_OPENAI_PRICING,
    outputTokenLimits: PINNED_OPENAI_OUTPUT_LIMITS,
  });
}

test("passes the workspace daily ceiling to the ledger with every reservation", async () => {
  const store = new FakeBudgetStore();
  await budgeted(new FakeGateway(), store, 5_000_000).generate(request());

  assert.equal(store.calls[0]?.workspaceDailyBudgetUsdMicros, 5_000_000);
});

test("a workspace-scoped rejection is reported as WORKSPACE_BUDGET_EXCEEDED before the provider call", async () => {
  const gateway = new FakeGateway();
  const store = new FakeBudgetStore();
  store.accepted = false;
  store.exhausted = "workspace";
  store.remainingUsdMicros = 10;

  await assert.rejects(
    () => budgeted(gateway, store, 5_000_000).generate(request()),
    (error: unknown) =>
      error instanceof ProviderBudgetError &&
      error.code === "WORKSPACE_BUDGET_EXCEEDED" &&
      error.retryable === false,
  );
  assert.equal(gateway.generateCalls, 0);
});

test("a run-scoped rejection keeps the PROVIDER_BUDGET_EXCEEDED code when a workspace ceiling is set", async () => {
  const store = new FakeBudgetStore();
  store.accepted = false;
  store.exhausted = "run";

  await assert.rejects(
    () => budgeted(new FakeGateway(), store, 5_000_000).generate(request()),
    (error: unknown) =>
      error instanceof ProviderBudgetError &&
      error.code === "PROVIDER_BUDGET_EXCEEDED",
  );
});

test("rejects a non-positive workspace ceiling at construction", () => {
  assert.throws(
    () => budgeted(new FakeGateway(), new FakeBudgetStore(), 0),
    RangeError,
  );
});

test("records the actual cost of a completed call", async () => {
  const store = new FakeBudgetStore();
  await budgeted(new PricedFakeGateway(), store).generate(request());

  assert.deepEqual(store.actuals, [{ runId: RUN_ID, actualUsdMicros: 4_321 }]);
});

test("records the actual cost when a stream completes", async () => {
  const store = new FakeBudgetStore();
  for await (const _event of budgeted(new PricedFakeGateway(), store).stream(request())) {
    // drain
  }

  assert.deepEqual(store.actuals, [{ runId: RUN_ID, actualUsdMicros: 4_321 }]);
});

test("records nothing when the response carries no cost estimate", async () => {
  const store = new FakeBudgetStore();
  await budgeted(new FakeGateway(), store).generate(request());

  assert.deepEqual(store.actuals, []);
});

test("a failed actual-cost write does not fail or discard a paid provider response", async () => {
  const store = new FakeBudgetStore();
  store.failRecordActual = true;

  const response = await budgeted(new PricedFakeGateway(), store).generate(request());

  assert.equal(response.status, "completed");
});

// Gemini pilot (2026-09-24): every model a policy can route to must have both
// a pricing entry (or reservation throws PROVIDER_MODEL_NOT_BUDGETED, see
// reserveConservativeCostUsdMicros) and an output-token limit, same invariant
// PINNED_OPENAI_* already had to hold, now checked for both providers.
for (const [label, models, pricing, outputLimits] of [
  ["openai", PINNED_OPENAI_MODELS, PINNED_OPENAI_PRICING, PINNED_OPENAI_OUTPUT_LIMITS],
  ["gemini", PINNED_GEMINI_MODELS, PINNED_GEMINI_PRICING, PINNED_GEMINI_OUTPUT_LIMITS],
] as const) {
  test(`every ${label} policy routes to a model with pinned pricing and an output limit`, () => {
    for (const model of Object.values(models)) {
      assert.ok(pricing[model], `${label}: ${model} has no pinned pricing`);
      assert.ok(outputLimits[model], `${label}: ${model} has no pinned output limit`);
    }
  });
}

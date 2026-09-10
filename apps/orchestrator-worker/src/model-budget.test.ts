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
  PINNED_OPENAI_OUTPUT_LIMITS,
  PINNED_OPENAI_PRICING,
  ProviderBudgetError,
  estimateTextRequestReservationUsdMicros,
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
    readonly ttlMs: number;
  }> = [];
  accepted = true;
  remainingUsdMicros = 1_000_000;

  async reserve(input: {
    readonly runId: string;
    readonly reservationUsdMicros: number;
    readonly totalBudgetUsdMicros: number;
    readonly ttlMs: number;
  }): Promise<{ readonly accepted: boolean; readonly remainingUsdMicros: number }> {
    this.calls.push(input);
    return {
      accepted: this.accepted,
      remainingUsdMicros: this.remainingUsdMicros,
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

test("zero configured budget fails closed before Redis or provider work", async () => {
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

test("rejects references because their provider cost is not safely pre-bounded", () => {
  assert.throws(
    () =>
      estimateTextRequestReservationUsdMicros({
        request: request({
          references: [
            {
              kind: "file",
              fileName: "context.txt",
              mimeType: "text/plain",
              dataBase64: "SGVsbG8=",
            },
          ],
        }),
        model: MODEL,
        pricing: PINNED_OPENAI_PRICING,
        outputTokenLimits: PINNED_OPENAI_OUTPUT_LIMITS,
        safetyMultiplier: 1.5,
      }),
    (error: unknown) =>
      error instanceof ProviderBudgetError &&
      error.code === "PROVIDER_BUDGET_REFERENCES_UNSUPPORTED",
  );
});

test("rejects a model output request above the pinned provider limit", () => {
  assert.throws(
    () =>
      estimateTextRequestReservationUsdMicros({
        request: request({ maxOutputTokens: 16_385 }),
        model: MODEL,
        pricing: PINNED_OPENAI_PRICING,
        outputTokenLimits: PINNED_OPENAI_OUTPUT_LIMITS,
        safetyMultiplier: 1.5,
      }),
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

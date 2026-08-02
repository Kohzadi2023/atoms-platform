import assert from "node:assert/strict";
import test from "node:test";

import type { Response } from "openai/resources/responses/responses";

import {
  OpenAIModelGateway,
  calculateCostUsdMicros,
  type ModelStreamEvent,
  type OpenAIClient,
} from "./index.js";

function responseFixture(model: string): Response {
  return {
    id: "resp_test",
    created_at: 1_785_520_000,
    output_text: "Generated output",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model,
    object: "response",
    output: [],
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    status: "completed",
    usage: {
      input_tokens: 100,
      input_tokens_details: {
        cached_tokens: 20,
        cache_write_tokens: 0,
      },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 150,
    },
  };
}

test("generate routes flagship to GPT-4o and records token/cost metadata", async () => {
  const requests: unknown[] = [];
  const client = {
    responses: {
      create: async (request: unknown) => {
        requests.push(request);
        return responseFixture("gpt-4o");
      },
    },
  } as unknown as OpenAIClient;
  const gateway = new OpenAIModelGateway({
    client,
    pricing: {
      "gpt-4o": {
        inputUsdPerMillionTokens: 5,
        cachedInputUsdPerMillionTokens: 2.5,
        outputUsdPerMillionTokens: 15,
      },
    },
  });

  const response = await gateway.generate({
    policy: "flagship",
    input: "Build a project plan",
    metadata: { runId: "run_123" },
  });

  assert.deepEqual(requests, [
    {
      model: "gpt-4o",
      input: "Build a project plan",
      store: false,
      metadata: { runId: "run_123" },
    },
  ]);
  assert.equal(response.model, "gpt-4o");
  assert.equal(response.usage.totalTokens, 150);
  assert.equal(response.usage.estimatedCostUsdMicros, 1_200);
});

test("fast policy routes to GPT-4o-mini", () => {
  const gateway = new OpenAIModelGateway({
    client: { responses: {} } as unknown as OpenAIClient,
  });
  assert.equal(gateway.resolveModel("fast"), "gpt-4o-mini");
});

test("stream normalizes Responses API deltas and completion metadata", async () => {
  const completedResponse = responseFixture("gpt-4o-mini");
  const client = {
    responses: {
      create: async () =>
        (async function* () {
          yield {
            type: "response.output_text.delta",
            delta: "Generated ",
            sequence_number: 1,
          };
          yield {
            type: "response.completed",
            response: completedResponse,
            sequence_number: 2,
          };
        })(),
    },
  } as unknown as OpenAIClient;
  const gateway = new OpenAIModelGateway({ client });
  const events: ModelStreamEvent[] = [];

  for await (const event of gateway.stream({
    policy: "fast",
    input: "Generate a route",
  })) {
    events.push(event);
  }

  assert.equal(events[0]?.type, "text_delta");
  assert.equal(events[1]?.type, "completed");
  assert.equal(
    events[1]?.type === "completed" ? events[1].response.model : undefined,
    "gpt-4o-mini",
  );
});

test("cost calculation clamps invalid cached-token counts", () => {
  assert.equal(
    calculateCostUsdMicros(10, 20, 5, {
      inputUsdPerMillionTokens: 2,
      cachedInputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 4,
    }),
    30,
  );
});


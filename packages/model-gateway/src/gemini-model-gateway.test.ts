import assert from "node:assert/strict";
import test from "node:test";

import type { ChatCompletion } from "openai/resources/chat/completions";

import {
  GeminiModelGateway,
  ModelGatewayError,
  calculateGeminiCostUsdMicros,
  type GeminiClient,
  type ModelStreamEvent,
} from "./index.js";

function completionFixture(model: string, overrides: Partial<ChatCompletion> = {}): ChatCompletion {
  return {
    id: "chatcmpl_test",
    created: 1_785_520_000,
    model,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content: "Generated output", refusal: null },
      },
    ],
    usage: {
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 150,
    },
    ...overrides,
  } as ChatCompletion;
}

test("generate routes flagship to gemini-2.5-pro and records token/cost metadata", async () => {
  const requests: unknown[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: unknown) => {
          requests.push(request);
          return completionFixture("gemini-2.5-pro");
        },
      },
    },
  } as unknown as GeminiClient;
  const gateway = new GeminiModelGateway({
    client,
    pricing: {
      "gemini-2.5-pro": {
        inputUsdPerMillionTokens: 5,
        cachedInputUsdPerMillionTokens: 2.5,
        outputUsdPerMillionTokens: 15,
      },
    },
  });

  const response = await gateway.generate({
    policy: "flagship",
    input: "Build a project plan",
  });

  assert.deepEqual(requests, [
    {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: [{ type: "text", text: "Build a project plan" }] }],
    },
  ]);
  assert.equal(response.provider, "google");
  assert.equal(response.model, "gemini-2.5-pro");
  assert.equal(response.status, "completed");
  assert.equal(response.outputText, "Generated output");
  assert.equal(response.usage.totalTokens, 150);
  assert.equal(response.usage.estimatedCostUsdMicros, 1_200);
});

test("default policy routes match the pinned model names", () => {
  const gateway = new GeminiModelGateway({
    client: { chat: { completions: {} } } as unknown as GeminiClient,
  });
  assert.equal(gateway.resolveModel("flagship"), "gemini-2.5-pro");
  assert.equal(gateway.resolveModel("balanced"), "gemini-2.5-flash");
  assert.equal(gateway.resolveModel("fast"), "gemini-2.5-flash");
  assert.equal(gateway.resolveModel("fallback"), "gemini-2.0-flash");
});

test("a text/plain reference is decoded and inlined; an image reference becomes image_url", async () => {
  const requests: unknown[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: unknown) => {
          requests.push(request);
          return completionFixture("gemini-2.5-flash");
        },
      },
    },
  } as unknown as GeminiClient;
  const gateway = new GeminiModelGateway({ client });

  await gateway.generate({
    policy: "balanced",
    instructions: "You are an agent.",
    input: "Extract requirements",
    references: [
      {
        kind: "file",
        fileName: "brief.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from("A real requirement.", "utf8").toString("base64"),
      },
      {
        kind: "image",
        fileName: "reference.png",
        mimeType: "image/png",
        dataBase64: "iVBORw==",
      },
    ],
  });

  const request = requests[0] as { messages: unknown[] };
  assert.deepEqual(request.messages[0], { role: "system", content: "You are an agent." });
  const userContent = (request.messages[1] as { content: unknown[] }).content;
  assert.deepEqual(userContent[0], { type: "text", text: "Extract requirements" });
  assert.deepEqual(userContent[1], {
    type: "text",
    text: "\n\n[Reference: brief.txt]\nA real requirement.",
  });
  assert.deepEqual(userContent[2], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,iVBORw==" },
  });
});

test("a PDF reference fails closed instead of being silently dropped", async () => {
  const gateway = new GeminiModelGateway({
    client: { chat: { completions: {} } } as unknown as GeminiClient,
  });

  await assert.rejects(
    gateway.generate({
      policy: "balanced",
      input: "Extract requirements",
      references: [
        { kind: "file", fileName: "brief.pdf", mimeType: "application/pdf", dataBase64: "JVBERg==" },
      ],
    }),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "INVALID_REQUEST",
  );
});

test("stream normalizes chat.completion.chunk deltas and completion metadata", async () => {
  const client = {
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            yield {
              id: "chatcmpl_stream",
              created: 1_785_520_000,
              model: "gemini-2.5-flash",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: "Generated " }, finish_reason: null, logprobs: null }],
            };
            yield {
              id: "chatcmpl_stream",
              created: 1_785_520_000,
              model: "gemini-2.5-flash",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: "output" }, finish_reason: "stop", logprobs: null }],
              usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            };
          })(),
      },
    },
  } as unknown as GeminiClient;
  const gateway = new GeminiModelGateway({ client });
  const events: ModelStreamEvent[] = [];

  for await (const event of gateway.stream({ policy: "fast", input: "Generate a route" })) {
    events.push(event);
  }

  assert.equal(events[0]?.type, "text_delta");
  assert.equal(events[0]?.type === "text_delta" ? events[0].delta : undefined, "Generated ");
  assert.equal(events[1]?.type, "text_delta");
  assert.equal(events[2]?.type, "completed");
  const completed = events[2]?.type === "completed" ? events[2].response : undefined;
  assert.equal(completed?.outputText, "Generated output");
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.usage.totalTokens, 12);
});

test("finish_reason maps to status: length and content_filter are incomplete, others complete", async () => {
  for (const [finishReason, expectedStatus, expectedReason] of [
    ["stop", "completed", undefined],
    ["length", "incomplete", "max_output_tokens"],
    ["content_filter", "incomplete", "content_filter"],
    ["tool_calls", "completed", undefined],
  ] as const) {
    const client = {
      chat: {
        completions: {
          create: async () =>
            completionFixture("gemini-2.5-flash", {
              choices: [
                {
                  index: 0,
                  finish_reason: finishReason,
                  logprobs: null,
                  message: { role: "assistant", content: "x", refusal: null },
                },
              ],
            }),
        },
      },
    } as unknown as GeminiClient;
    const gateway = new GeminiModelGateway({ client });
    const response = await gateway.generate({ policy: "fast", input: "x" });
    assert.equal(response.status, expectedStatus, finishReason);
    assert.equal(response.incompleteReason, expectedReason, finishReason);
  }
});

test("provider errors from the shared openai SDK normalize the same way as the OpenAI gateway", async () => {
  const client = {
    chat: {
      completions: {
        create: async () => {
          throw new Error("network down");
        },
      },
    },
  } as unknown as GeminiClient;
  const gateway = new GeminiModelGateway({ client });

  await assert.rejects(
    gateway.generate({ policy: "fast", input: "x" }),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "PROVIDER_ERROR",
  );
});

test("cost calculation clamps invalid cached-token counts, same arithmetic as the OpenAI gateway", () => {
  assert.equal(
    calculateGeminiCostUsdMicros(10, 20, 5, {
      inputUsdPerMillionTokens: 2,
      cachedInputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 4,
    }),
    30,
  );
});

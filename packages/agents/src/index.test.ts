import assert from "node:assert/strict";
import test from "node:test";

import type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "@atoms/model-gateway";

import {
  AgentRuntimeError,
  AlexOutputSchema,
  ModelBackedAgentRuntime,
  SophiaOutputSchema,
  agentManifests,
} from "./index.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";

class FakeGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  outputText = JSON.stringify({
    summary: "Implemented the supported project.",
    files: [
      {
        path: "app/page.tsx",
        content: "export default function Page() { return null; }",
        expectedVersion: 0,
      },
    ],
    commands: {
      lint: "pnpm lint",
      typecheck: "pnpm typecheck",
      test: "pnpm test",
      build: "pnpm build",
    },
  });

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      id: "resp_1",
      provider: "openai",
      policy: request.policy,
      model: "test-model",
      status: "completed",
      outputText: this.outputText,
      createdAt: "2026-07-31T12:00:00.000Z",
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

  async *stream(): AsyncIterable<ModelStreamEvent> {}
}

test("all active agent manifests are versioned and schema-bound", () => {
  assert.deepEqual(Object.keys(agentManifests), [
    "Sophia",
    "Mike",
    "Emma",
    "Bob",
    "Alex",
    "David",
    "Sarah",
    "Adrian",
  ]);
  for (const manifest of Object.values(agentManifests)) {
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(manifest.maxOutputTokens > 0);
  }
});

test("Sophia requires sources for claims marked as evidenced", () => {
  const base = {
    summary: "Evidence-aware market view.",
    marketDefinition: {
      targetCustomer: "Canadian accounting firms",
      geography: ["Canada"],
      segments: ["Small and midsize accounting firms"],
      jobsToBeDone: ["Reduce manual financial document processing"],
    },
    icp: {
      primarySegment: "Accounting firms with recurring bookkeeping workload",
      firmographics: [],
      painPoints: ["Manual document review"],
      buyingTriggers: [],
      objections: [],
    },
    competitors: [],
    marketSizing: {
      tam: { estimate: null, basis: "No sourced market count supplied", evidenceStatus: "RESEARCH_REQUIRED" },
      sam: { estimate: null, basis: "No sourced segment count supplied", evidenceStatus: "RESEARCH_REQUIRED" },
      som: { estimate: null, basis: "Pilot capacity not yet validated", evidenceStatus: "ASSUMPTION" },
    },
    pricing: { observedBenchmarks: [], hypotheses: [] },
    positioning: {
      category: "Accounting automation",
      wedge: "Exception-first financial document processing",
      differentiators: [],
      alternatives: [],
    },
    risks: [],
    claims: [
      {
        claim: "The target segment is growing rapidly",
        evidenceStatus: "EVIDENCED",
        source: null,
      },
    ],
    researchRequests: [],
  } as const;

  assert.equal(SophiaOutputSchema.safeParse(base).success, false);
  assert.equal(
    SophiaOutputSchema.safeParse({
      ...base,
      claims: [
        {
          claim: "The target segment is growing rapidly",
          evidenceStatus: "RESEARCH_REQUIRED",
          source: null,
        },
      ],
    }).success,
    true,
  );
});

test("ModelBackedAgentRuntime sends scoped metadata and validates Alex output", async () => {
  const gateway = new FakeGateway();
  const runtime = new ModelBackedAgentRuntime(gateway);
  const output = await runtime.execute({
    agentName: "Alex",
    runId: RUN_ID,
    prompt: "Build a customer portal",
    upstreamOutputs: {},
    currentFiles: [],
    referenceAttachments: [
      {
        id: "00000000-0000-4000-8000-000000000002",
        kind: "image",
        fileName: "reference.png",
        mimeType: "image/png",
        dataBase64: "iVBORw==",
      },
    ],
  });

  assert.deepEqual(output, AlexOutputSchema.parse(JSON.parse(gateway.outputText)));
  assert.equal(gateway.requests[0]?.metadata?.agent, "Alex");
  assert.equal(gateway.requests[0]?.metadata?.run_id, RUN_ID);
  assert.equal(gateway.requests[0]?.policy, "flagship");
  assert.deepEqual(gateway.requests[0]?.references, [
    {
      kind: "image",
      fileName: "reference.png",
      mimeType: "image/png",
      dataBase64: "iVBORw==",
    },
  ]);
});

test("ModelBackedAgentRuntime rejects prose that does not contain schema-valid JSON", async () => {
  const gateway = new FakeGateway();
  gateway.outputText = "I created the application.";
  const runtime = new ModelBackedAgentRuntime(gateway);

  await assert.rejects(
    runtime.execute({
      agentName: "Alex",
      runId: RUN_ID,
      prompt: "Build a customer portal",
      upstreamOutputs: {},
      currentFiles: [],
    }),
    (error: unknown) =>
      error instanceof AgentRuntimeError &&
      error.code === "INVALID_AGENT_OUTPUT" &&
      !error.retryable,
  );
});

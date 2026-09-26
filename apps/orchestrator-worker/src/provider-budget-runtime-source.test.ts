import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("worker runtime keeps provider budget fail-closed, durable, and pinned", async () => {
  const source = await readFile(resolve(process.cwd(), "src/main.ts"), "utf8");

  assert.match(
    source,
    /RUN_PROVIDER_BUDGET_USD_MICROS:[\s\S]*?\.default\(0\)/u,
  );
  assert.match(source, /new PostgresRunProviderBudgetStore\(prisma\)/u);
  assert.match(
    source,
    /new OpenAIModelGateway\s*\([\s\S]*?models: PINNED_OPENAI_MODELS/u,
  );
  assert.match(source, /pricing: PINNED_OPENAI_PRICING/u);
  assert.match(source, /new BudgetedModelGateway\s*\(/u);
  assert.match(
    source,
    /totalBudgetUsdMicros: environment\.RUN_PROVIDER_BUDGET_USD_MICROS/u,
  );
  assert.match(source, /const agents = new ModelBackedAgentRuntime\(gateway\)/u);
  assert.doesNotMatch(source, /RUN_PROVIDER_BUDGET_TTL_MS/u);
});

test("worker runtime refuses a per-run budget without a workspace ceiling and passes the ceiling through", async () => {
  const source = await readFile(resolve(process.cwd(), "src/main.ts"), "utf8");

  assert.match(
    source,
    /WORKSPACE_PROVIDER_BUDGET_USD_MICROS_PER_DAY:[\s\S]*?\.default\(0\)/u,
  );
  assert.match(
    source,
    /RUN_PROVIDER_BUDGET_USD_MICROS > 0 &&\s*environment\.WORKSPACE_PROVIDER_BUDGET_USD_MICROS_PER_DAY === 0/u,
  );
  assert.match(
    source,
    /workspaceDailyBudgetUsdMicros:\s*environment\.WORKSPACE_PROVIDER_BUDGET_USD_MICROS_PER_DAY/u,
  );
});

// Gemini pilot (2026-09-24): MODEL_PROVIDER selects the gateway; both branches
// must be wired to their own pinned pricing/output-limit tables, never fall
// through to the other provider's, and OPENAI_API_KEY must have moved off
// "required" now that it is not the only provider.
test("MODEL_PROVIDER selects the gateway and its own pinned pricing, defaulting to openai", async () => {
  const source = await readFile(resolve(process.cwd(), "src/main.ts"), "utf8");

  assert.match(source, /MODEL_PROVIDER: z\.enum\(\["openai", "google"\]\)\.default\("openai"\)/u);
  assert.match(source, /OPENAI_API_KEY: z\.string\(\)\.min\(1\)\.optional\(\)/u);
  assert.match(source, /GOOGLE_API_KEY: z\.string\(\)\.min\(1\)\.optional\(\)/u);
  assert.match(
    source,
    /environment\.MODEL_PROVIDER === "google"\s*\n\s*\? new GeminiModelGateway\(\{[\s\S]*?models: PINNED_GEMINI_MODELS,\s*\n\s*pricing: PINNED_GEMINI_PRICING,/u,
  );
  assert.match(
    source,
    /\? \[PINNED_GEMINI_PRICING, PINNED_GEMINI_OUTPUT_LIMITS\]\s*\n\s*: \[PINNED_OPENAI_PRICING, PINNED_OPENAI_OUTPUT_LIMITS\]/u,
  );
});

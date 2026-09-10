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

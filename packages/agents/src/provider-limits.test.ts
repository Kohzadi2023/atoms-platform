import assert from "node:assert/strict";
import test from "node:test";

import { agentManifests } from "./manifests.js";

// A manifest's maxOutputTokens is a shared, provider-agnostic request: the
// orchestrator-worker's BudgetedModelGateway clamps it down to whichever active
// model's real ceiling is lower (e.g. GPT-4o's 16,384) before the call goes out,
// so this only needs to guard against an unreasonable value, not any one
// provider's specific limit.
const SANITY_UPPER_BOUND = 100_000;

test("every agent requests a positive, sane maxOutputTokens", () => {
  for (const [name, manifest] of Object.entries(agentManifests)) {
    assert.ok(
      Number.isInteger(manifest.maxOutputTokens) && manifest.maxOutputTokens > 0,
      `${name} must request a positive integer maxOutputTokens`,
    );
    assert.ok(
      manifest.maxOutputTokens <= SANITY_UPPER_BOUND,
      `${name} requests ${String(manifest.maxOutputTokens)} tokens, above the ${String(SANITY_UPPER_BOUND)} sanity bound`,
    );
  }
});

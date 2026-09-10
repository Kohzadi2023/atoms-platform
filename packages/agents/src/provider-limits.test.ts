import assert from "node:assert/strict";
import test from "node:test";

import { agentManifests } from "./manifests.js";

const PINNED_TEXT_OUTPUT_LIMIT = 16_384;

test("all agent max output requests fit the pinned OpenAI text model limit", () => {
  for (const [name, manifest] of Object.entries(agentManifests)) {
    assert.ok(
      manifest.maxOutputTokens <= PINNED_TEXT_OUTPUT_LIMIT,
      `${name} requests ${String(manifest.maxOutputTokens)} tokens, above ${String(PINNED_TEXT_OUTPUT_LIMIT)}`,
    );
  }
});

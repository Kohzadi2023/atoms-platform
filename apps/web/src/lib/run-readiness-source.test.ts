import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("run readiness UI cannot invoke live run creation", async () => {
  const source = await readFile(
    resolve(process.cwd(), "src/components/run-readiness-gate.tsx"),
    "utf8",
  );

  assert.match(source, /Prepare run readiness — no execution/u);
  assert.match(source, /I_ACCEPT_ONE_LIVE_OPENAI_E2B_STAGING_RUN/u);
  assert.doesNotMatch(source, /\.createRun\s*\(/u);
  assert.doesNotMatch(source, /\/runs/u);
  assert.doesNotMatch(source, /OpenAI\.create/u);
  assert.doesNotMatch(source, /new\s+E2B/u);
});

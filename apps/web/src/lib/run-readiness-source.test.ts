import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("run readiness UI cannot invoke live run creation", async () => {
  const componentSource = await readFile(
    resolve(process.cwd(), "src/components/run-readiness-gate.tsx"),
    "utf8",
  );
  const readinessSource = await readFile(
    resolve(process.cwd(), "src/lib/run-readiness.ts"),
    "utf8",
  );

  assert.match(componentSource, /Prepare run readiness — no execution/u);
  assert.match(componentSource, /LIVE_PROVIDER_CONFIRMATION/u);
  assert.match(readinessSource, /I_ACCEPT_ONE_LIVE_OPENAI_E2B_STAGING_RUN/u);
  assert.match(readinessSource, /MAX_ALLOWED_COST_CAD\s*=\s*4/u);
  assert.doesNotMatch(componentSource, /\.createRun\s*\(/u);
  assert.doesNotMatch(componentSource, /\/runs/u);
  assert.doesNotMatch(componentSource, /OpenAI\.create/u);
  assert.doesNotMatch(componentSource, /new\s+E2B/u);
});

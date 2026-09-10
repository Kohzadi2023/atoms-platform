import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("workspace project creation cannot start a run", async () => {
  const source = await readFile(
    resolve(process.cwd(), "src/components/workspace-shell.tsx"),
    "utf8",
  );

  const createStart = source.indexOf("async function createProjectOnly");
  const launchStart = source.indexOf("async function launchRun");

  assert.notEqual(createStart, -1, "createProjectOnly handler must exist");
  assert.notEqual(launchStart, -1, "launchRun handler must exist");
  assert.ok(createStart < launchStart, "project creation must be a distinct earlier phase");

  const createProjectOnly = source.slice(createStart, launchStart);
  const launchRun = source.slice(launchStart, source.indexOf("function selectAttachments"));

  assert.match(createProjectOnly, /api\.createProject\s*\(/u);
  assert.match(createProjectOnly, /api\.getProject\s*\(/u);
  assert.doesNotMatch(createProjectOnly, /api\.createRun\s*\(/u);
  assert.doesNotMatch(createProjectOnly, /\/runs/u);

  assert.match(launchRun, /validateLiveRunConsent\s*\(/u);
  assert.match(launchRun, /LIVE_PROVIDER_CONFIRMATION/u);
  assert.match(launchRun, /MAX_ALLOWED_COST_CAD/u);
  assert.match(launchRun, /api\.createRun\s*\(/u);

  assert.match(source, /Create project only — no run/u);
  assert.match(source, /Launch run — may use OpenAI\/E2B/u);
  assert.doesNotMatch(source, /createProjectRun/u);
});

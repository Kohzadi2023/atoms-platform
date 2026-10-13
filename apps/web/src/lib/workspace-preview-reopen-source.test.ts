import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

async function shellSource(): Promise<string> {
  return readFile(resolve(process.cwd(), "src/components/workspace-shell.tsx"), "utf8");
}

test("re-opening a preview calls only the reopen API and can never start or retry a run", async () => {
  const source = await shellSource();
  const start = source.indexOf("async function reopenPreview");
  assert.notEqual(start, -1, "reopenPreview handler must exist");
  // The handler is followed directly by the launch-consent computation.
  const end = source.indexOf("\n  const launchConsent", start);
  assert.notEqual(end, -1, "the handler must be followed by the launch-consent computation");
  const handler = source.slice(start, end);

  assert.match(handler, /api\.reopenProjectPreview\s*\(\s*project\.id\s*\)/u);
  assert.doesNotMatch(handler, /api\.createRun\s*\(/u);
  assert.doesNotMatch(handler, /api\.runAction\s*\(/u);
  assert.doesNotMatch(handler, /providerConfirmation/u);
});

test("the Re-open button is offered only when the preview can be reopened, and the wait is bounded", async () => {
  const source = await shellSource();

  assert.match(source, /canReopenPreview\(run\?\.status, projection\.preview, nowMs\)/u);
  assert.match(source, /canReopen=\{canReopen\}/u);
  assert.match(source, /Re-open preview/u);
  assert.match(source, /REOPEN_PREVIEW_TIMEOUT_MS/u);
  // The finished run's stream has ended, so waiting re-opens it on a timer.
  assert.match(source, /setStreamEpoch\(\(epoch\) => epoch \+ 1\)/u);
});

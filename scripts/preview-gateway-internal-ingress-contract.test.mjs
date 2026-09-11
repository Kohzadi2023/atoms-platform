import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL(
  "../deploy/staging/preview-gateway-enable-internal-ingress.ps1",
  import.meta.url,
);

async function source() {
  return readFile(scriptUrl, "utf8");
}

test("preview ingress gate is staging-only and internal-only", async () => {
  const text = await source();

  assert.equal(text.startsWith("Clear-Host"), true);
  assert.match(text, /2ac8ed24-166b-4325-89dc-829d64391ce9/);
  assert.match(text, /bbcaf423-9a71-43bc-9fc7-821ef012cd01/);
  assert.match(text, /RUN_EXECUTION_ENABLED/);
  assert.match(text, /AUTH_REQUIRED/);
  assert.match(text, /preview\.invalid/);
  assert.match(text, /--type","internal"/);
  assert.match(text, /--target-port","\$TargetPort"/);
  assert.match(text, /Microsoft\.App\/managedEnvironments\/httpRouteConfigs/);
  assert.match(text, /min=0\/max=1/);
  assert.match(text, /\.internal\./);
});

test("preview ingress gate cannot expose public preview or enable providers", async () => {
  const text = await source();

  for (const forbidden of [
    '--type","external"',
    '"hostname","add"',
    '"hostname","bind"',
    '"certificate","upload"',
    "RUN_EXECUTION_ENABLED=true",
    "OPENAI_API_KEY",
    "E2B_API_KEY",
  ]) {
    assert.equal(text.includes(forbidden), false, `forbidden token present: ${forbidden}`);
  }

  assert.match(text, /No health request was sent to the Preview Gateway/);
  assert.match(text, /Public exposure\s+: NONE/);
  assert.match(text, /Custom domain \/ TLS\s+: NOT configured/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("../deploy/staging/preview-gateway-internal-health-smoke.ps1", import.meta.url),
  "utf8",
);

test("preview internal health smoke stays fail-closed and provider-disabled", () => {
  assert.match(source, /^Clear-Host/);
  assert.match(source, /2ac8ed24-166b-4325-89dc-829d64391ce9/);
  assert.match(source, /bbcaf423-9a71-43bc-9fc7-821ef012cd01/);
  assert.match(source, /RUN_EXECUTION_ENABLED/);
  assert.match(source, /preview\.invalid/);
  assert.match(source, /external=false/);
  assert.match(source, /Microsoft\.App\/managedEnvironments\/httpRouteConfigs/);
  assert.match(source, /containerapp","debug/);
  assert.match(source, /--command/);
  assert.match(source, /wget -qO- --timeout=30/);
  assert.match(source, /\/healthz/);
  assert.match(
    source,
    /atoms-staging-preview-gateway\.internal\.proudpond-7f6fcfdd\.canadacentral\.azurecontainerapps\.io/,
  );
  assert.match(source, /Provider execution\s+: NONE/);

  for (const forbidden of [
    '--type","external"',
    '"hostname","add"',
    '"hostname","bind"',
    '"certificate","upload"',
    "RUN_EXECUTION_ENABLED=true",
    "OPENAI_API_KEY",
    "E2B_API_KEY",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

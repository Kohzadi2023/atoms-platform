import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("../deploy/staging/preview-gateway-internal-health-smoke.ps1", import.meta.url),
  "utf8",
);

test("preview internal health smoke uses an ephemeral same-environment job and stays fail-closed", () => {
  assert.match(source, /^Clear-Host/);
  assert.match(source, /2ac8ed24-166b-4325-89dc-829d64391ce9/);
  assert.match(source, /bbcaf423-9a71-43bc-9fc7-821ef012cd01/);
  assert.match(source, /RUN_EXECUTION_ENABLED/);
  assert.match(source, /preview\.invalid/);
  assert.match(source, /Microsoft\.App\/managedEnvironments\/httpRouteConfigs/);
  assert.match(source, /containerapp","job","create/);
  assert.match(source, /containerapp","job","start/);
  assert.match(source, /containerapp","job","execution","show/);
  assert.match(source, /containerapp job delete/);
  assert.match(source, /lifecycle=ephemeral/);
  assert.match(source, /atoms-staging-acr-pull/);
  assert.match(source, /TARGET_URL=/);
  assert.match(source, /ATOMS_PREVIEW_HEALTH_OK/);
  assert.match(source, /r\.status!==200\|\|b!==e/);
  assert.match(source, /Provider execution\s+: NONE/);
  assert.match(source, /PREVIEW GATEWAY INTERNAL HEALTH SMOKE SUCCEEDED/);

  for (const forbidden of [
    'containerapp","debug',
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

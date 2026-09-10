import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("CI keeps the Web fast path conservative and full CI on main", async () => {
  const workflow = await read(".github/workflows/ci.yml");

  assert.match(workflow, /git diff --name-only/u);
  assert.match(workflow, /node scripts\/classify-ci-changes\.mjs/u);
  assert.match(workflow, /pnpm --filter @atoms\/web\.\.\. build/u);
  assert.match(workflow, /pnpm --filter @atoms\/web test/u);
  assert.match(workflow, /pnpm --filter @atoms\/web typecheck/u);

  const fullCiGuards = workflow.match(/if: needs\.changes\.outputs\.full_ci == 'true'/gu) ?? [];
  assert.ok(fullCiGuards.length >= 5, "full-CI-only work must stay explicitly guarded");

  assert.match(workflow, /push:\n\s+branches: \[main\]/u);
  assert.match(workflow, /printf '%s\\n' 'push-to-main'/u);
});

test("canonical Web deploy is exact-SHA capable and keeps staging/Entra guards", async () => {
  const deploy = await read("deploy/staging/entra-web-cutover.ps1");

  assert.match(deploy, /ExpectedSourceSha/u);
  assert.match(deploy, /Source SHA mismatch/u);
  assert.match(deploy, /NEXT_PUBLIC_ENTRA_TENANT_ID=\$ExpectedTenantId/u);
  assert.match(deploy, /2ac8ed24-166b-4325-89dc-829d64391ce9/u);
  assert.match(deploy, /bbcaf423-9a71-43bc-9fc7-821ef012cd01/u);
  assert.match(deploy, /Start-Transcript/u);
  assert.match(deploy, /Set-Clipboard/u);
});

test("public staging smoke stays read-only and covers the shared readiness gates", async () => {
  const smoke = await read("scripts/staging-public-smoke.ps1");

  for (const route of ["/project-readiness", "/redirect", "/readyz", "/v1/me", "/v1/workspaces"]) {
    assert.ok(smoke.includes(route), `missing public smoke route ${route}`);
  }

  assert.match(smoke, /Method Options/u);
  assert.match(smoke, /Access-Control-Allow-Origin/u);
  assert.doesNotMatch(smoke, /containerapp update/u);
  assert.doesNotMatch(smoke, /acr build/u);
  assert.doesNotMatch(smoke, /Connect-MgGraph/u);
});

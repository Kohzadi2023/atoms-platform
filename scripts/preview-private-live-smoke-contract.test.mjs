import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const text = path => readFileSync(new URL(path, root), "utf8");
function run(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: fileURLToPath(root), timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr || stdout || error.message}`));
      else resolve(stdout);
    });
  });
}

test("operator-successful v17/v18 scripts are preserved byte for byte", () => {
  for (const [path, hash] of [
    ["scripts/atoms-staging-preview-gateway-private-rollout-resume-v17.ps1", "b921f7700f59cb031f13dfee2d5c9ad6fa7dca4fc1af9fad514dc8cc77b60331"],
    ["scripts/atoms-staging-preview-gateway-private-live-session-smoke-v18.ps1", "377a8215148bf9c707cb4fcbdc2bf42cc1a32235e5d5d23b733d98398be91d17"],
  ]) assert.equal(createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex"), hash);
});

for (const [version, harness] of [[17, "test-private-rollout-v17.ps1"],
  [18, "test-private-live-session-v18.ps1"], [19, "test-private-rejection-v19.ps1"]]) {
  test(`v${version} offline PowerShell control flow and recovery`, { timeout: 100000 }, async () => {
    const output = await run(process.env.PWSH_PATH ?? "pwsh", ["-NoProfile", "-File",
      fileURLToPath(new URL(`scripts/${harness}`, root))], 90000);
    assert.match(output, /OFFLINE.*TESTS PASSED/);
    assert.match(output, /No Azure requests? (?:was |were )?made/);
  });
}
for (const [name, harness] of [["v18 live session", "test-live-session-payload.mjs"],
  ["v19 rejection", "test-rejection-payload.mjs"]]) {
  test(`${name} embedded payload on the real local Gateway`, { timeout: 60000 }, async () => {
    const output = await run(process.execPath, [fileURLToPath(new URL(`scripts/preview-smoke/${harness}`, root))], 55000);
    assert.match(output, /PASSED/);
  });
}

test("v19 remains scale-only and full CI exercises its offline harness", () => {
  const source = text("scripts/atoms-staging-preview-gateway-private-rejection-smoke-v19.ps1");
  assert.doesNotMatch(source, /"acr", "build"|"containerapp", "job"|list-credentials/);
  assert.match(source, /maximum initial TTL=60s/);
  assert.match(source, /one to three bounded chunks/);
  assert.match(source, /PREVIEW_REDIS_MODE/);
  assert.match(source, /FAILED_\(PACKAGE\|FIXTURE/);
  assert.match(source, /If-Match=/);
  assert.match(source, /PRIVATE HTTP\/WEBSOCKET REJECTION SMOKE SUCCEEDED/);
  const workflow = text(".github/workflows/ci.yml");
  for (const file of ["atoms-staging-preview-gateway-private-rollout-resume-v17.ps1",
    "atoms-staging-preview-gateway-private-live-session-smoke-v18.ps1",
    "atoms-staging-preview-gateway-private-rejection-smoke-v19.ps1",
    "test-private-rollout-v17.ps1", "test-private-live-session-v18.ps1", "test-private-rejection-v19.ps1"]) {
    assert.ok(workflow.includes(`"scripts/${file}"`), file);
  }
  assert.ok(JSON.parse(text("package.json")).scripts["test:staging-deployment"].includes("scripts/preview-private-live-smoke-contract.test.mjs"));
  assert.ok(text("scripts/scan-secrets.mjs").includes('".ps1"'));
});

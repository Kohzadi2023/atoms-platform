import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = readFileSync(
  new URL("../deploy/staging/preview-gateway-internal-health-smoke.ps1", import.meta.url),
  "utf8",
);

const payload = /\$ProbeJavaScript = @'\r?\n([\s\S]*?)\r?\n'@/.exec(source)?.[1];

test("preview internal health smoke uses a file-based job and stays fail-closed", () => {
  assert.match(source, /^Clear-Host/);
  assert.match(source, /2ac8ed24-166b-4325-89dc-829d64391ce9/);
  assert.match(source, /bbcaf423-9a71-43bc-9fc7-821ef012cd01/);
  assert.match(source, /RUN_EXECUTION_ENABLED/);
  assert.match(source, /preview\.invalid/);
  assert.match(source, /Microsoft\.App\/managedEnvironments\/httpRouteConfigs/);
  assert.match(source, /"containerapp", "job", "create"/);
  assert.match(source, /"containerapp", "job", "start"/);
  assert.match(source, /"containerapp", "job", "execution", "show"/);
  assert.match(source, /"containerapp", "job", "delete"/);
  assert.match(source, /lifecycle = "ephemeral"/);
  assert.match(source, /atoms-staging-acr-pull/);
  assert.match(source, /"--yaml", \$script:JobConfigPath/);
  assert.match(source, /name = "TARGET_URL"/);
  assert.doesNotMatch(source, /"--args"|function Az\b/);
  assert.match(source, /Get-Command az -CommandType Application/);
  assert.match(source, /2> \$stderrPath/);
  assert.doesNotMatch(source, /2>&1/);
  assert.match(source, /Require-ProbeOwnership \$jobs\[0\]/);
  assert.ok(source.indexOf("$script:JobMayExist = $true") < source.indexOf('"--yaml", $script:JobConfigPath'));
  assert.match(source, /ATOMS_PREVIEW_HEALTH_OK/);
  assert.ok(payload);
  assert.match(payload, /Buffer\.from\(await response\.arrayBuffer\(\)\)/);
  assert.match(payload, /response\.status !== 200 \|\| !body\.equals\(expected\)/);
  assert.match(payload, /redirect: "manual"/);
  assert.match(payload, /clearTimeout\(timeout\)/);
  assert.match(source, /Provider execution\s+: NONE/);
  assert.match(source, /PREVIEW GATEWAY INTERNAL HEALTH SMOKE SUCCEEDED/);

  for (const forbidden of [
    '"containerapp", "debug"',
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

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000, ...options }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr, error });
    });
  });
}

async function healthFixture(context, status, body) {
  let redirectedHits = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirected") redirectedHits += 1;
    response.writeHead(status, status === 302 ? { location: "/redirected" } : {});
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    url: "http://127.0.0.1:" + server.address().port + "/healthz",
    redirectedHits: () => redirectedHits,
  };
}

for (const [name, status, body, expected] of [
  ["exact HTTP 200/body succeeds and its timer does not keep Node alive", 200, '{"status":"ok"}', 0],
  ["whitespace is not an exact health response", 200, '{"status":"ok"}\n', 2],
  ["a UTF-8 BOM is not a byte-exact health response", 200, '\uFEFF{"status":"ok"}', 2],
  ["additional JSON fields cannot pass the gate", 200, '{"status":"ok","extra":true}', 2],
  ["an unhealthy HTTP status cannot pass even with the right body", 503, '{"status":"ok"}', 2],
  ["health redirects are rejected without contacting their target", 302, '{"status":"ok"}', 2],
]) {
  test(name, async (context) => {
    const fixture = await healthFixture(context, status, body);
    const result = await run(process.execPath, ["--eval", payload], {
      env: { TARGET_URL: fixture.url },
    });
    assert.equal(result.code, expected, result.stderr);
    if (expected === 0) {
      assert.equal(result.stdout.trim(), 'ATOMS_PREVIEW_HEALTH_OK {"status":"ok"}');
      assert.equal(result.stderr, "");
    } else {
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), "ATOMS_PREVIEW_HEALTH_FAIL");
    }
    assert.equal(fixture.redirectedHits(), 0);
  });
}

test("network errors expose only a fixed diagnostic token, never URL/error detail", async () => {
  const result = await run(process.execPath, ["--eval", payload], {
    env: { TARGET_URL: "not-a-url-local-private-fixture" },
  });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "ATOMS_PREVIEW_HEALTH_ERROR");
});

test("the bounded timeout aborts fetch and is cleared on failure", async () => {
  let abort;
  let cleared = 0;
  const diagnostics = [];
  const fakeProcess = { env: { TARGET_URL: "http://loopback-fixture/healthz" }, exitCode: 0 };
  runInNewContext(payload, {
    AbortController,
    Buffer,
    process: fakeProcess,
    console: { error: (token) => diagnostics.push(token), log: () => assert.fail("must not pass") },
    setTimeout: (callback, delay) => { assert.equal(delay, 60_000); abort = callback; return 1; },
    clearTimeout: (timer) => { assert.equal(timer, 1); cleared += 1; },
    fetch: (_url, { signal, redirect }) => {
      assert.equal(redirect, "manual");
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private-fixture-timeout"))));
    },
  });
  abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fakeProcess.exitCode, 3);
  assert.equal(cleared, 1);
  assert.deepEqual(diagnostics, ["ATOMS_PREVIEW_HEALTH_ERROR"]);
});

test("PowerShell parses and exercises real control flow with an offline fake CLI", async () => {
  const result = await run(process.env.PWSH_PATH ?? "pwsh", [
    "-NoProfile", "-File",
    fileURLToPath(new URL("./test-preview-internal-health.ps1", import.meta.url)),
    "-SourcePath",
    fileURLToPath(new URL("../deploy/staging/preview-gateway-internal-health-smoke.ps1", import.meta.url)),
  ], { timeout: 30_000 });
  assert.equal(result.code, 0, result.stderr || String(result.error));
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith("ATOMS_HEALTH_TEST_RESULT "));
  assert.ok(line, result.stdout);
  const evidence = JSON.parse(line.slice("ATOMS_HEALTH_TEST_RESULT ".length));
  assert.equal(evidence.cases.length, 15);
  const job = evidence.config;
  assert.equal(job.properties.environmentId.endsWith("/managedEnvironments/atoms-staging-env"), true);
  assert.equal(job.properties.configuration.triggerType, "Manual");
  assert.equal(job.properties.configuration.replicaRetryLimit, 0);
  assert.equal(job.properties.configuration.replicaTimeout, 120);
  assert.equal(job.properties.configuration.secrets, undefined);
  assert.equal(job.properties.configuration.ingress, undefined);
  assert.equal(job.identity.type, "UserAssigned");
  assert.deepEqual(Object.keys(job.identity.userAssignedIdentities), [job.properties.configuration.registries[0].identity]);
  assert.equal(job.properties.template.containers.length, 1);
  const container = job.properties.template.containers[0];
  assert.deepEqual(container.command, ["node"]);
  assert.deepEqual(container.args, ["--eval", payload]);
  assert.deepEqual(container.env, [{ name: "TARGET_URL", value: "https://atoms-staging-preview-gateway.internal.proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io/healthz" }]);
  assert.equal(JSON.stringify(job).includes("local-fixture-not-for-job"), false);
});

test("CI parses the health gate and fake-CLI harness without running Azure", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /"deploy\/staging\/preview-gateway-internal-health-smoke\.ps1"/);
  assert.match(workflow, /"scripts\/test-preview-internal-health\.ps1"/);
  const harness = readFileSync(new URL("./test-preview-internal-health.ps1", import.meta.url), "utf8");
  assert.match(harness, /NEVER execute the live try\/finally entry/);
  assert.match(harness, /function Invoke-Az/);
  assert.doesNotMatch(harness, /& az\b|az login|az account/);
});

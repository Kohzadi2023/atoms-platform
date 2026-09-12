import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// Verify the resolved Docker Compose JSON, not just source text/anchors.
export function verifyPreviewRuntimeCompose(config) {
  assert.equal(config.name, "atoms-ci-preview-runtime");
  const expected = ["gateway", "mock-upstream", "redis-1", "redis-2", "redis-3", "redis-cluster-init", "smoke"];
  assert.deepEqual(Object.keys(config.services).sort(), expected);
  assert.deepEqual(Object.keys(config.networks), ["fixture"]);
  assert.equal(config.networks.fixture.internal, true);
  assert.notEqual(config.networks.fixture.external, true);
  assert.equal(Object.keys(config.volumes ?? {}).length, 0);
  assert.equal(Object.keys(config.secrets ?? {}).length, 0);
  assert.equal(Object.keys(config.configs ?? {}).length, 0);
  for (const [name, service] of Object.entries(config.services)) {
    for (const property of ["ports", "env_file", "secrets", "configs", "external_links", "devices"]) {
      assert.equal((service[property] ?? []).length, 0, name + " must not use " + property);
    }
    assert.notEqual(service.privileged, true);
    assert.equal(service.network_mode, undefined);
    assert.equal(service.pid, undefined);
    assert.equal(service.restart, undefined);
    assert.deepEqual(Object.keys(service.networks), ["fixture"]);
    if (name.startsWith("redis")) assert.equal(service.image, "redis:8-alpine");
    else {
      assert.equal(service.image, "atoms-ci/preview-gateway:local");
      assert.equal(service.pull_policy, "never");
      assert.equal(service.read_only, true);
      assert.deepEqual(service.cap_drop, ["ALL"]);
      assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
      assert.equal(service.user, undefined, "exercise the image's own USER");
    }
    for (const volume of service.volumes ?? []) {
      assert.equal(volume.type, "bind");
      assert.equal(volume.read_only, true);
      assert.ok(volume.source.endsWith("/deploy/ci/preview"));
      assert.equal(volume.target, name === "redis-cluster-init" ? "/ci" : "/app/ci");
    }
  }
  const gateway = config.services.gateway;
  assert.equal(gateway.build.dockerfile, "apps/preview-gateway/Dockerfile");
  assert.equal(gateway.command, undefined, "exercise the actual image entry point");
  assert.equal(gateway.volumes, undefined, "never overlay the application under test");
  assert.equal(gateway.environment.PREVIEW_REDIS_MODE, "oss-cluster");
  assert.equal(gateway.environment.PREVIEW_BASE_DOMAIN, "preview.invalid");
  assert.equal(gateway.environment.REDIS_URL, "redis://redis-1:6379/0");
  assert.equal(gateway.environment.PREVIEW_SIGNING_SECRET, "ci-private-preview-signing-secret-never-use-live");
  assert.equal(gateway.environment.PREVIEW_UI_ORIGIN, "https://ui.example.test");
  assert.equal(gateway.environment.PREVIEW_PUBLIC_PROTOCOL, "https");
  assert.equal(gateway.environment.PREVIEW_GATEWAY_HOST, "0.0.0.0");
  assert.equal(gateway.environment.PREVIEW_GATEWAY_PORT, "3002");
  assert.equal(Object.keys(gateway.environment).length, 8);
  const smoke = config.services.smoke;
  assert.deepEqual(smoke.command, ["node", "ci/runtime-smoke.mjs"]);
  assert.deepEqual(smoke.environment, {
    RUN_PREVIEW_RUNTIME_INTEGRATION_TESTS: "true",
    PREVIEW_RUNTIME_INTEGRATION_CONFIRMATION: "DEDICATED_EPHEMERAL_REDIS_CLUSTER",
    REDIS_URL: "redis://redis-1:6379/0",
    PREVIEW_BASE_DOMAIN: "preview.invalid",
    RUN_EXECUTION_ENABLED: "false",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    verifyPreviewRuntimeCompose(JSON.parse(input));
    console.log("ATOMS_PREVIEW_RUNTIME_COMPOSE_OK");
  } catch {
    console.error("ATOMS_PREVIEW_RUNTIME_COMPOSE_FAILED");
    process.exitCode = 1;
  }
}

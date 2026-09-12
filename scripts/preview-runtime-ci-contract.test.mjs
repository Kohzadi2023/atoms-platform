import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyPreviewRuntimeCompose } from "./verify-preview-runtime-compose.mjs";
import { productionGraph, verifyPreviewPackage } from "./verify-preview-package.mjs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
function fixture() {
  const runtime = () => ({
    image: "atoms-ci/preview-gateway:local", pull_policy: "never", read_only: true,
    cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], networks: { fixture: {} },
  });
  return {
    name: "atoms-ci-preview-runtime", networks: { fixture: { internal: true } },
    services: {
      "redis-1": { image: "redis:8-alpine", networks: { fixture: {} } },
      "redis-2": { image: "redis:8-alpine", networks: { fixture: {} } },
      "redis-3": { image: "redis:8-alpine", networks: { fixture: {} } },
      "redis-cluster-init": { image: "redis:8-alpine", networks: { fixture: {} } },
      gateway: { ...runtime(), build: { dockerfile: "apps/preview-gateway/Dockerfile" }, environment: {
        REDIS_URL: "redis://redis-1:6379/0", PREVIEW_REDIS_MODE: "oss-cluster",
        PREVIEW_SIGNING_SECRET: "ci-private-preview-signing-secret-never-use-live",
        PREVIEW_BASE_DOMAIN: "preview.invalid", PREVIEW_UI_ORIGIN: "https://ui.example.test",
        PREVIEW_PUBLIC_PROTOCOL: "https", PREVIEW_GATEWAY_HOST: "0.0.0.0", PREVIEW_GATEWAY_PORT: "3002",
      } },
      "mock-upstream": runtime(),
      smoke: { ...runtime(), command: ["node", "ci/runtime-smoke.mjs"], environment: {
        RUN_PREVIEW_RUNTIME_INTEGRATION_TESTS: "true",
        PREVIEW_RUNTIME_INTEGRATION_CONFIRMATION: "DEDICATED_EPHEMERAL_REDIS_CLUSTER",
        REDIS_URL: "redis://redis-1:6379/0", PREVIEW_BASE_DOMAIN: "preview.invalid", RUN_EXECUTION_ENABLED: "false",
      } },
    },
  };
}
test("resolved preview CI topology accepts only the isolated exact fixture", () => verifyPreviewRuntimeCompose(fixture()));
test("resolved Compose JSON null commands and entrypoints inherit the image defaults", () => {
  const c = fixture();
  for (const service of Object.values(c.services)) {
    service.entrypoint = null;
    if (!service.command) service.command = null;
  }
  verifyPreviewRuntimeCompose(c);
});
for (const [name, change] of [
  ["public ports", (c) => { c.services.gateway.ports = [{ published: "3002", target: 3002 }]; }],
  ["non-internal network", (c) => { c.networks.fixture.internal = false; }],
  ["external network", (c) => { c.networks.fixture.external = true; }],
  ["production Redis", (c) => { c.services.gateway.environment.REDIS_URL = "rediss://live.invalid:10000/0"; }],
  ["provider credentials", (c) => { c.services.gateway.environment.OPENAI_API_KEY = "fixture-should-not-be-copied"; }],
  ["an application overlay", (c) => { c.services.gateway.volumes = [{ type: "bind", source: "/repo/deploy/ci/preview", target: "/app/ci", read_only: true }]; }],
  ["an image command override", (c) => { c.services.gateway.command = ["node", "fake-main.js"]; }],
  ["an image entrypoint override", (c) => { c.services.gateway.entrypoint = ["node", "fake-main.js"]; }],
  ["an explicitly cleared image command", (c) => { c.services.gateway.command = []; }],
  ["a host env file", (c) => { c.services.smoke.env_file = ["/repo/.env"]; }],
  ["privileged service", (c) => { c.services.smoke.privileged = true; }],
  ["an unconfirmed smoke", (c) => { delete c.services.smoke.environment.PREVIEW_RUNTIME_INTEGRATION_CONFIRMATION; }],
  ["a different Compose project", (c) => { c.name = "atoms-production"; }],
]) {
  test("resolved preview CI topology rejects " + name, () => {
    const c = fixture(); change(c); assert.throws(() => verifyPreviewRuntimeCompose(c));
  });
}
test("Gateway runtime copies only a portable production package and runs non-root", () => {
  const dockerfile = read("apps/preview-gateway/Dockerfile");
  const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
  assert.match(dockerfile, /pnpm --filter @atoms\/preview-gateway deploy --prod --legacy \/out/);
  assert.match(dockerfile, /node scripts\/verify-preview-package\.mjs apps\/preview-gateway\/package\.json \/out\/package\.json/);
  assert.match(runtime, /COPY --from=build --chown=node:node \/out\/ \/app\//);
  assert.doesNotMatch(runtime, /COPY.*\/workspace/);
  assert.match(runtime, /USER node/);
  assert.match(runtime, /CMD \["node", "dist\/main.js"\]/);
  for (const file of ["apps/preview-gateway/package.json", "packages/preview/package.json"]) {
    assert.deepEqual(JSON.parse(read(file)).files, ["dist"]);
  }
});
test("package graph check needs no prior build and rejects portable transitive version drift", (context) => {
  const root = mkdtempSync(join(tmpdir(), "atoms-preview-package-contract-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  function packageFixture(name, dependencyVersion) {
    const directory = join(root, name);
    const dependency = join(directory, "node_modules", "fixture-dependency");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      name: "fixture-gateway", version: "1.0.0", dependencies: { "fixture-dependency": "^1.0.0" },
    }));
    writeFileSync(join(dependency, "package.json"), JSON.stringify({
      name: "fixture-dependency", version: dependencyVersion, main: "index.js",
    }));
    writeFileSync(join(dependency, "index.js"), "module.exports = {};");
    return join(directory, "package.json");
  }
  const source = packageFixture("source", "1.0.0");
  const deployed = packageFixture("deployed", "1.0.0");
  assert.deepEqual(productionGraph(source), {
    "fixture-gateway@1.0.0": { "fixture-dependency": "fixture-dependency@1.0.0" },
    "fixture-dependency@1.0.0": {},
  });
  verifyPreviewPackage(source, deployed);
  assert.throws(() => verifyPreviewPackage(source, packageFixture("drift", "1.0.1")));
});
test("packaged runtime CI cannot publish images, deploy Azure, or skip its integration", () => {
  const workflow = read(".github/workflows/ci.yml");
  const job = workflow.split("  preview-runtime-integration:")[1]?.split("  attachment-storage-integration:")[0];
  assert.ok(job, "full CI must include a separate packaged-runtime job");
  assert.match(job, /if: needs\.changes\.outputs\.full_ci == 'true'/);
  assert.match(job, /COMPOSE_FILE: deploy\/ci\/compose\.preview-runtime\.yaml/);
  assert.match(job, /COMPOSE_PROJECT_NAME: atoms-ci-preview-runtime/);
  assert.match(job, /docker compose config --format json \| node scripts\/verify-preview-runtime-compose\.mjs/);
  assert.match(job, /docker compose build gateway/);
  assert.match(job, /docker image inspect atoms-ci\/preview-gateway:local --format '\{\{\.Config\.User\}\}' \| grep -Fx node/);
  assert.match(job, /docker compose up -d --no-build --wait --wait-timeout 90 gateway mock-upstream/);
  assert.match(job, /docker compose run --rm --no-deps smoke/);
  assert.match(job, /docker compose stop --timeout 10 gateway/);
  assert.match(job, /if: failure\(\)/);
  assert.match(job, /if: always\(\)/);
  assert.match(job, /docker compose down --volumes --remove-orphans/);
  for (const token of ["continue-on-error", "docker push", "docker login", "az ", "E2B_API_KEY", "OPENAI_API_KEY"]) {
    assert.equal(job.includes(token), false, "runtime CI must not add " + token);
  }
});
test("real cluster/image smoke spans shards and exercises production code, not a gateway mock", () => {
  const smoke = read("deploy/ci/preview/runtime-smoke.mjs");
  assert.match(smoke, /from "@atoms\/preview"/);
  assert.match(smoke, /new RedisPreviewSessionStore\(\{ redisUrl: REDIS_URL, redisMode: "oss-cluster" \}\)/);
  assert.match(smoke, /groups\.size, 3/);
  assert.match(smoke, /\^MOVED \\d\+/);
  assert.match(smoke, /ATOMS_PREVIEW_RUNTIME_OK/);
  assert.match(smoke, /await websocket\("\/hmr", originalHost, 101\)/);
  assert.match(smoke, /await store\.delete/);
  assert.match(smoke, /await delay\(650\)/);
  assert.doesNotMatch(smoke, /FLUSHALL|FLUSHDB|buildPreviewGateway|\.skip\(/i);
  const main = read("apps/preview-gateway/src/main.ts");
  const worker = read("apps/orchestrator-worker/src/main.ts");
  for (const source of [main, worker]) {
    assert.match(source, /PREVIEW_REDIS_MODE: PreviewRedisModeSchema/);
    assert.match(source, /redisMode: environment\.PREVIEW_REDIS_MODE/);
  }
});

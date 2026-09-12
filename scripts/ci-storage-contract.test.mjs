import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("storage CI selects an isolated overlay and builds before starting services", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const job = workflow.slice(workflow.indexOf("  attachment-storage-integration:"));
  assert.match(job, /COMPOSE_FILE: compose\.yaml:deploy\/ci\/compose\.storage\.yaml/);
  assert.match(job, /COMPOSE_PROJECT_NAME: atoms-ci-storage/);
  assert.match(job, /docker compose config --quiet/);
  assert.match(job, /docker compose build minio minio-init/);
  assert.ok(job.indexOf("docker compose build") < job.indexOf("docker compose up"));
  assert.match(job, /docker compose up -d --no-build minio clamav/);
  assert.match(job, /docker compose run --rm --no-build minio-init/);
});

test("CI overlay changes only MinIO image/build selection, never runtime boundaries", async () => {
  const overlay = await read("deploy/ci/compose.storage.yaml");
  assert.deepEqual([...overlay.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]), ["minio", "minio-init"]);
  assert.equal([...overlay.matchAll(/pull_policy: never/g)].length, 2);
  assert.equal([...overlay.matchAll(/context: deploy\/ci/g)].length, 2);
  assert.equal([...overlay.matchAll(/dockerfile: minio\.Dockerfile/g)].length, 2);
  assert.match(overlay, /target: minio/);
  assert.match(overlay, /target: mc/);
  assert.equal(/^\s+(environment|command|entrypoint|ports|volumes|secrets|networks):/m.test(overlay), false);
});

test("CI uses the same MinIO and mc release versions as the existing Compose fixtures", async () => {
  const [compose, overlay, dockerfile] = await Promise.all([
    read("compose.yaml"), read("deploy/ci/compose.storage.yaml"), read("deploy/ci/minio.Dockerfile"),
  ]);
  for (const [name, release] of [
    ["minio", "RELEASE.2025-09-07T16-13-09Z"],
    ["mc", "RELEASE.2025-08-13T08-35-41Z"],
  ]) {
    assert.ok(compose.includes(`minio/${name}:${release}`));
    assert.ok(overlay.includes(`atoms-ci/${name}:${release}`));
    assert.ok(dockerfile.includes(`--branch ${release} https://github.com/minio/${name}.git`));
  }
});

test("official MinIO source tags must match immutable release commits before compilation", async () => {
  const dockerfile = await read("deploy/ci/minio.Dockerfile");
  assert.match(dockerfile, /test "\$\(git rev-parse HEAD\)" = "07c3a429bfed433e49018cb0f78a52145d4bedeb"/);
  assert.match(dockerfile, /test "\$\(git rev-parse HEAD\)" = "7394ce0dd2a80935aded936b09fa12cbb3cb8096"/);
  assert.equal([...dockerfile.matchAll(/go build -mod=readonly -trimpath/g)].length, 2);
  assert.match(dockerfile, /CGO_ENABLED=0 GOTOOLCHAIN=local/);
  assert.equal(dockerfile.includes("@latest"), false);
  assert.equal(dockerfile.includes(":latest"), false);
  assert.match(dockerfile, /FROM golang:1\.27\.1 AS go-base/);
});

test("CI runtime preserves shell support, trusted certificates, and both upstream licenses", async () => {
  const dockerfile = await read("deploy/ci/minio.Dockerfile");
  assert.match(dockerfile, /FROM busybox:1\.37\.0 AS runtime/);
  assert.match(dockerfile, /COPY --from=go-base \/etc\/ssl\/certs\/ca-certificates\.crt/);
  assert.match(dockerfile, /COPY --from=minio-build \/src\/LICENSE/);
  assert.match(dockerfile, /COPY --from=mc-build \/src\/LICENSE/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/minio"\]/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/mc"\]/);
  assert.equal(/^COPY \. /m.test(dockerfile), false, "do not copy application files or host credentials into dependency images");
});

test("storage opt-in, KMS/CORS/malware tests, bounded readiness, logs, and cleanup remain enforced", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const job = workflow.slice(workflow.indexOf("  attachment-storage-integration:"));
  assert.match(job, /RUN_STORAGE_INTEGRATION_TESTS: "true"/);
  assert.match(job, /STORAGE_INTEGRATION_CONFIRMATION: DEDICATED_EPHEMERAL_STORAGE/);
  assert.match(job, /S3_KMS_KEY_ID: local-dev-key/);
  assert.match(job, /run: pnpm staging:attachments:storage/);
  assert.equal([...job.matchAll(/for attempt in \{1\.\.60\}/g)].length, 2);
  assert.match(job, /docker compose exec -T clamav clamdscan --ping 1/);
  assert.match(job, /if: failure\(\)[\s\S]*docker compose logs --no-color minio minio-init clamav/);
  assert.match(job, /if: always\(\)[\s\S]*docker compose down --volumes --remove-orphans/);
  for (const token of ["continue-on-error", "docker login", "docker push", "az deployment", "OPENAI_API_KEY", "E2B_API_KEY"]) {
    assert.equal(job.includes(token), false, `storage CI must not introduce ${token}`);
  }
});

test("production staging Compose remains independent of CI-only dependency images", async () => {
  const staging = await read("deploy/staging/compose.yaml");
  assert.equal(staging.includes("atoms-ci/"), false);
  assert.equal(staging.includes("deploy/ci/"), false);
});

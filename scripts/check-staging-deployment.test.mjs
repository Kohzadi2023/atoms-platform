import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateStagingDeployment } from "./check-staging-deployment.mjs";
import {
  createStagingDeploymentFixture,
  environmentText,
} from "./staging-deployment-fixture.mjs";

const preflightPath = fileURLToPath(
  new URL("./check-staging-deployment.mjs", import.meta.url),
);
const composeValidationPath = fileURLToPath(
  new URL("./validate-staging-compose.mjs", import.meta.url),
);
const stagingComposePath = fileURLToPath(
  new URL("../deploy/staging/compose.yaml", import.meta.url),
);

async function fixtureForTest(t, options) {
  const fixture = await createStagingDeploymentFixture(options);
  t.after(() => fixture.cleanup());
  return fixture;
}

test("accepts a complete secret-safe staging contract", async (t) => {
  const fixture = await fixtureForTest(t);

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });

  assert.deepEqual(result, {
    ok: true,
    violations: [],
    checked: {
      publicEnvironmentFiles: 1,
      serviceEnvironmentFiles: 4,
      opaqueSecretFiles: 7,
      tlsFiles: 2,
    },
  });
});

test("storage ingress is shared only by Caddy and MinIO", async () => {
  const compose = await readFile(stagingComposePath, "utf8");
  const services = compose.slice(
    compose.indexOf("services:\n") + "services:\n".length,
    compose.indexOf("\nnetworks:\n"),
  );
  const connectedServices = [];
  let currentService;
  for (const line of services.split("\n")) {
    const service = /^  ([a-z0-9-]+):$/u.exec(line);
    if (service !== null) currentService = service[1];
    if (line === "      - storage-ingress" && currentService !== undefined) {
      connectedServices.push(currentService);
    }
  }
  connectedServices.sort();

  assert.deepEqual(connectedServices, ["minio", "reverse-proxy"]);
});

test("service preflight does not need operator smoke tokens, but smoke preflight does", async (t) => {
  const fixture = await fixtureForTest(t);
  await rm(join(fixture.secretsDirectory, "authenticated-smoke.env"));
  const options = { environmentFile: fixture.environmentFile, secretsDirectory: fixture.secretsDirectory };
  assert.equal((await validateStagingDeployment(options)).ok, true);
  const smoke = await validateStagingDeployment({ ...options, requireAuthenticatedSmoke: true });
  assert.equal(smoke.ok, false);
  assert.match(smoke.violations.join("\n"), /authenticated-smoke\.env is missing/u);
});

test("smoke preflight accepts operator JWTs and rejects legacy password fields without disclosure", async (t) => {
  const fixture = await fixtureForTest(t);
  const options = {
    environmentFile: fixture.environmentFile, secretsDirectory: fixture.secretsDirectory,
    requireAuthenticatedSmoke: true,
  };
  const valid = await validateStagingDeployment(options);
  assert.equal(valid.ok, true);
  assert.equal(valid.checked.serviceEnvironmentFiles, 5);
  const file = join(fixture.secretsDirectory, "authenticated-smoke.env");
  await chmod(file, 0o600);
  await writeFile(file, `${await readFile(file, "utf8")}ATOMS_SMOKE_PRIMARY_PASSWORD=private-password-canary\n`);
  await chmod(file, 0o444);
  const invalid = await validateStagingDeployment(options);
  assert.equal(invalid.ok, false);
  assert.match(invalid.violations.join("\n"), /unsupported variable ATOMS_SMOKE_PRIMARY_PASSWORD/u);
  for (const value of ["private-password-canary", fixture.values.smokePrimaryToken, fixture.values.smokeForeignToken]) {
    assert.ok(!JSON.stringify(invalid).includes(value));
  }
});

test("GUID issuer alias and named JWKS work for the exact browser tenant", async (t) => {
  const fixture = await fixtureForTest(t);
  const content = await readFile(fixture.environmentFile, "utf8");
  await writeFile(fixture.environmentFile, content.replace(
    "ATOMS_AUTH_ISSUER_URL=https://fixture-tenant.ciamlogin.com/",
    "ATOMS_AUTH_ISSUER_URL=https://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.ciamlogin.com/",
  ));
  assert.equal((await validateStagingDeployment({
    environmentFile: fixture.environmentFile, secretsDirectory: fixture.secretsDirectory,
  })).ok, true);
});

for (const [name, replace] of [
  ["missing tenant", (text) => text.replace(/^ATOMS_ENTRA_TENANT_ID=.*\n/mu, "")],
  ["different tenant", (text) => text.replace("ATOMS_ENTRA_TENANT_ID=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "ATOMS_ENTRA_TENANT_ID=bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee")],
  ["foreign issuer", (text) => text.replace("ATOMS_AUTH_ISSUER_URL=https://fixture-tenant.ciamlogin.com/", "ATOMS_AUTH_ISSUER_URL=https://unrelated-tenant.ciamlogin.com/")],
  ["foreign JWKS", (text) => text.replace("ATOMS_AUTH_JWKS_URL=https://fixture-tenant.ciamlogin.com/", "ATOMS_AUTH_JWKS_URL=https://unrelated-tenant.ciamlogin.com/")],
]) {
  test(`rejects ${name} before a staging build`, async (t) => {
    const fixture = await fixtureForTest(t);
    await writeFile(fixture.environmentFile, replace(await readFile(fixture.environmentFile, "utf8")));
    const result = await validateStagingDeployment({
      environmentFile: fixture.environmentFile, secretsDirectory: fixture.secretsDirectory,
    });
    assert.equal(result.ok, false);
    assert.match(result.violations.join("\n"), /[Tt]enant|JWKS/u);
  });
}

test("rejects a certificate without the required wildcard preview SAN", async (t) => {
  const fixture = await fixtureForTest(t, {
    tlsDnsNames: [
      "app.staging.atoms.dev",
      "api.staging.atoms.dev",
      "storage.staging.atoms.dev",
      "preview.staging.atoms.dev",
    ],
  });

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /wildcard SAN/u);
});

test("rejects a certificate without the exact storage SAN", async (t) => {
  const fixture = await fixtureForTest(t, {
    tlsDnsNames: [
      "app.staging.atoms.dev",
      "api.staging.atoms.dev",
      "*.preview.staging.atoms.dev",
    ],
  });

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });

  assert.equal(result.ok, false);
  assert.match(
    result.violations.join("\n"),
    /TLS certificate must cover ATOMS_STORAGE_ORIGIN/u,
  );
});

test("rejects a TLS private key that does not match the certificate", async (t) => {
  const fixture = await fixtureForTest(t);
  const otherFixture = await fixtureForTest(t);
  const targetKey = join(fixture.secretsDirectory, "tls-private-key.pem");
  await chmod(targetKey, 0o600);
  await copyFile(join(otherFixture.secretsDirectory, "tls-private-key.pem"), targetKey);
  await chmod(targetKey, 0o444);

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /certificate and private key must match/u);
});

test("rejects a TLS certificate too close to expiry", async (t) => {
  const fixture = await fixtureForTest(t, { tlsDays: 1 });

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /remain valid for at least seven days/u);
});

test("rejects a writable service secret file", async (t) => {
  const fixture = await fixtureForTest(t);
  await chmod(join(fixture.secretsDirectory, "worker.env"), 0o644);

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /worker\.env permissions must be exactly 0444/u);
});

test("rejects development credentials in the public deployment env without leaking them", async (t) => {
  const fixture = await fixtureForTest(t);
  const developmentToken = "browser-visible-development-token-0123456789";
  await writeFile(
    fixture.environmentFile,
    `${await readFile(fixture.environmentFile, "utf8")}AUTH_DEV_ACCESS_TOKEN=${developmentToken}\n`,
  );

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });
  const output = result.violations.join("\n");

  assert.equal(result.ok, false);
  assert.match(output, /unsupported variable AUTH_DEV_ACCESS_TOKEN/u);
  assert.doesNotMatch(output, new RegExp(developmentToken, "u"));
});

test("rejects mismatched service credentials without exposing either value", async (t) => {
  const fixture = await fixtureForTest(t);
  const mismatchedPassword = "mismatched-redis-passphrase-0123456789";
  const workerEnvironmentPath = join(fixture.secretsDirectory, "worker.env");
  const workerEnvironment = await readFile(workerEnvironmentPath, "utf8");
  await chmod(workerEnvironmentPath, 0o600);
  await writeFile(
    workerEnvironmentPath,
    workerEnvironment.replace(
      fixture.values.redisUrl,
      `redis://:${encodeURIComponent(mismatchedPassword)}@redis:6379`,
    ),
  );
  await chmod(workerEnvironmentPath, 0o444);

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });
  const output = result.violations.join("\n");

  assert.equal(result.ok, false);
  assert.match(output, /REDIS_URL must match/u);
  assert.doesNotMatch(output, new RegExp(mismatchedPassword, "u"));
  assert.doesNotMatch(output, new RegExp(fixture.values.redisPassword, "u"));
});

test("rejects placeholder domains, non-HTTPS origins, and abbreviated image tags", async (t) => {
  const fixture = await fixtureForTest(t);
  const content = await readFile(fixture.environmentFile, "utf8");
  await writeFile(
    fixture.environmentFile,
    content
      .replace("ATOMS_IMAGE_TAG=" + "a".repeat(40), "ATOMS_IMAGE_TAG=abc1234")
      .replace(
        "ATOMS_WEB_ORIGIN=https://app.staging.atoms.dev",
        "ATOMS_WEB_ORIGIN=http://app.staging.example.com",
      )
      .replace(
        "ATOMS_CONTROL_API_ORIGIN=https://api.staging.atoms.dev",
        "ATOMS_CONTROL_API_ORIGIN=https://127.0.0.1",
      ),
  );

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });
  const output = result.violations.join("\n");

  assert.equal(result.ok, false);
  assert.match(output, /full lowercase 40-character Git SHA/u);
  assert.match(output, /ATOMS_WEB_ORIGIN must use a real HTTPS endpoint/u);
  assert.match(output, /ATOMS_CONTROL_API_ORIGIN must use a DNS hostname/u);
});

test("rejects nonstandard ingress ports and app names under the preview wildcard", async (t) => {
  const fixture = await fixtureForTest(t);
  const content = await readFile(fixture.environmentFile, "utf8");
  await writeFile(
    fixture.environmentFile,
    content
      .replace(
        "ATOMS_WEB_ORIGIN=https://app.staging.atoms.dev",
        "ATOMS_WEB_ORIGIN=https://app.preview.staging.atoms.dev",
      )
      .replace(
        "ATOMS_CONTROL_API_ORIGIN=https://api.staging.atoms.dev",
        "ATOMS_CONTROL_API_ORIGIN=https://api.staging.atoms.dev:8443",
      ),
  );

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });
  const output = result.violations.join("\n");

  assert.equal(result.ok, false);
  assert.match(output, /default HTTPS port/u);
  assert.match(output, /outside the wildcard preview domain/u);
});

test("requires all live provider credentials in the worker-only env file", async (t) => {
  const fixture = await fixtureForTest(t);
  const workerEnvironmentPath = join(fixture.secretsDirectory, "worker.env");
  const content = await readFile(workerEnvironmentPath, "utf8");
  await chmod(workerEnvironmentPath, 0o600);
  await writeFile(
    workerEnvironmentPath,
    content
      .split("\n")
      .filter((line) => !line.startsWith("SUPABASE_ACCESS_TOKEN="))
      .join("\n"),
  );
  await chmod(workerEnvironmentPath, 0o444);

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /worker\.env is missing SUPABASE_ACCESS_TOKEN/u);
});

test("explicit authenticated-smoke preflight rejects identical bearer tokens", async (t) => {
  const fixture = await fixtureForTest(t);
  const smokeEnvironmentPath = join(
    fixture.secretsDirectory,
    "authenticated-smoke.env",
  );
  const content = await readFile(smokeEnvironmentPath, "utf8");
  await chmod(smokeEnvironmentPath, 0o600);
  await writeFile(
    smokeEnvironmentPath,
    content.replace(
      `ATOMS_SMOKE_FOREIGN_ACCESS_TOKEN=${fixture.values.smokeForeignToken}`,
      `ATOMS_SMOKE_FOREIGN_ACCESS_TOKEN=${fixture.values.smokePrimaryToken}`,
    ),
  );
  await chmod(smokeEnvironmentPath, 0o444);

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
    requireAuthenticatedSmoke: true,
  });

  assert.equal(result.ok, false);
  assert.match(
    result.violations.join("\n"),
    /authenticated smoke requires two different bearer tokens/u,
  );
});

test("rejects duplicate environment assignments", async (t) => {
  const fixture = await fixtureForTest(t);
  const migrationPath = join(fixture.secretsDirectory, "migration.env");
  await chmod(migrationPath, 0o600);
  await writeFile(
    migrationPath,
    environmentText({
      DATABASE_URL: fixture.values.databaseUrl,
      DATABASE_URL_DUPLICATE_SENTINEL: fixture.values.databaseUrl,
    }).replace("DATABASE_URL_DUPLICATE_SENTINEL", "DATABASE_URL"),
  );
  await chmod(migrationPath, 0o444);

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /defines DATABASE_URL more than once/u);
});

test("CLI diagnostics identify contracts without printing credential values", async (t) => {
  const fixture = await fixtureForTest(t);
  const workerEnvironmentPath = join(fixture.secretsDirectory, "worker.env");
  await chmod(workerEnvironmentPath, 0o600);
  await writeFile(
    workerEnvironmentPath,
    `${await readFile(workerEnvironmentPath, "utf8")}UNSUPPORTED_PRIVATE_VALUE=${fixture.values.vaultCredential}\n`,
  );
  await chmod(workerEnvironmentPath, 0o444);

  const result = spawnSync(
    process.execPath,
    [
      preflightPath,
      "--",
      "--env-file",
      fixture.environmentFile,
      "--secrets-dir",
      fixture.secretsDirectory,
    ],
    { encoding: "utf8" },
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /unsupported variable UNSUPPORTED_PRIVATE_VALUE/u);
  for (const secret of [
    fixture.values.databasePassword,
    fixture.values.redisPassword,
    fixture.values.s3SecretAccessKey,
    fixture.values.openAiCredential,
    fixture.values.e2bCredential,
    fixture.values.supabaseCredential,
    fixture.values.vaultCredential,
    fixture.values.smokePrimaryToken,
    fixture.values.smokeForeignToken,
  ]) {
    assert.doesNotMatch(output, new RegExp(secret, "u"));
  }
});

test("Compose validation rejects partial path arguments before invoking Docker", () => {
  const result = spawnSync(
    process.execPath,
    [composeValidationPath, "--", "--env-file", "--secrets-dir", "/tmp/not-used"],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--env-file requires a path/u);
  assert.doesNotMatch(result.stderr, /Docker/u);
});

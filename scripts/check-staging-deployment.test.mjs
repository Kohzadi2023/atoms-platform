import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
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

async function fixtureForTest(t) {
  const fixture = await createStagingDeploymentFixture();
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
    },
  });
});

test("rejects a service env file readable by group or others", async (t) => {
  const fixture = await fixtureForTest(t);
  await chmod(join(fixture.secretsDirectory, "worker.env"), 0o644);

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /worker\.env permissions/u);
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
  await writeFile(
    workerEnvironmentPath,
    workerEnvironment.replace(
      fixture.values.redisUrl,
      `redis://:${encodeURIComponent(mismatchedPassword)}@redis:6379`,
    ),
    { mode: 0o600 },
  );
  await chmod(workerEnvironmentPath, 0o600);

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

test("requires all live provider credentials in the worker-only env file", async (t) => {
  const fixture = await fixtureForTest(t);
  const workerEnvironmentPath = join(fixture.secretsDirectory, "worker.env");
  const content = await readFile(workerEnvironmentPath, "utf8");
  await writeFile(
    workerEnvironmentPath,
    content
      .split("\n")
      .filter((line) => !line.startsWith("SUPABASE_ACCESS_TOKEN="))
      .join("\n"),
    { mode: 0o600 },
  );
  await chmod(workerEnvironmentPath, 0o600);

  const result = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /worker\.env is missing SUPABASE_ACCESS_TOKEN/u);
});

test("rejects duplicate environment assignments", async (t) => {
  const fixture = await fixtureForTest(t);
  const migrationPath = join(fixture.secretsDirectory, "migration.env");
  await writeFile(
    migrationPath,
    environmentText({
      DATABASE_URL: fixture.values.databaseUrl,
      DATABASE_URL_DUPLICATE_SENTINEL: fixture.values.databaseUrl,
    }).replace("DATABASE_URL_DUPLICATE_SENTINEL", "DATABASE_URL"),
    { mode: 0o600 },
  );
  await chmod(migrationPath, 0o600);

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
  await writeFile(
    workerEnvironmentPath,
    `${await readFile(workerEnvironmentPath, "utf8")}UNSUPPORTED_PRIVATE_VALUE=${fixture.values.vaultCredential}\n`,
    { mode: 0o600 },
  );
  await chmod(workerEnvironmentPath, 0o600);

  const result = spawnSync(
    process.execPath,
    [
      preflightPath,
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
  ]) {
    assert.doesNotMatch(output, new RegExp(secret, "u"));
  }
});

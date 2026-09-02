import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AZURE_STAGING_DEPLOY_CONFIRMATION,
  AZURE_STAGING_PLAN_CONFIRMATION,
  validateAzureStagingInputs,
} from "./validate-azure-staging-inputs.mjs";

const validatorPath = fileURLToPath(
  new URL("./validate-azure-staging-inputs.mjs", import.meta.url),
);

const validEnvironment = {
  AZURE_STAGING_MODE: "what-if",
  AZURE_STAGING_CONFIRMATION: AZURE_STAGING_PLAN_CONFIRMATION,
  AZURE_STAGING_CHANGE_TICKET: "GH-22",
  AZURE_STAGING_MAX_MONTHLY_COST_CAD: "80",
  AZURE_STAGING_LOCATION: "canadacentral",
  AZURE_STAGING_RESOURCE_GROUP: "atoms-staging-rg",
  AZURE_STAGING_VM_SIZE: "Standard_B2s_v2",
  AZURE_STAGING_SSH_SOURCE_CIDR: "203.0.113.42/32",
  AZURE_STAGING_SSH_PUBLIC_KEY:
    "ssh-ed25519 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA atoms-staging-test",
  AZURE_BUDGET_CONTACT_EMAIL: "operator@example.test",
  AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
  AZURE_TENANT_ID: "22222222-2222-4222-8222-222222222222",
  AZURE_SUBSCRIPTION_ID: "33333333-3333-4333-8333-333333333333",
};

test("accepts a read-only what-if with the exact approved boundary", () => {
  const result = validateAzureStagingInputs(validEnvironment);

  assert.equal(result.ok, true, result.violations.join("\n"));
  assert.equal(result.mode, "what-if");
});

test("accepts deployment only with its independent provisioning acknowledgement", () => {
  const result = validateAzureStagingInputs({
    ...validEnvironment,
    AZURE_STAGING_MODE: "deploy",
    AZURE_STAGING_CONFIRMATION: AZURE_STAGING_DEPLOY_CONFIRMATION,
  });

  assert.equal(result.ok, true, result.violations.join("\n"));
  assert.equal(result.mode, "deploy");
});

test("rejects using the planning acknowledgement for a billable deployment", () => {
  const result = validateAzureStagingInputs({
    ...validEnvironment,
    AZURE_STAGING_MODE: "deploy",
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /deploy acknowledgement/u);
});

test("rejects a monthly budget other than the approved CAD 80", () => {
  const result = validateAzureStagingInputs({
    ...validEnvironment,
    AZURE_STAGING_MAX_MONTHLY_COST_CAD: "81",
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /exactly equal 80/u);
});

test("rejects changing the approved region or VM size", () => {
  const result = validateAzureStagingInputs({
    ...validEnvironment,
    AZURE_STAGING_LOCATION: "eastus",
    AZURE_STAGING_VM_SIZE: "Standard_D2s_v5",
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /canadacentral/u);
  assert.match(result.violations.join("\n"), /Standard_B2s_v2/u);
});

test("rejects any resource group outside the dedicated Atoms boundary", () => {
  const result = validateAzureStagingInputs({
    ...validEnvironment,
    AZURE_STAGING_RESOURCE_GROUP: "LogiCount-RG",
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /atoms-staging-rg/u);
});

test("rejects malformed OIDC identity identifiers", () => {
  const result = validateAzureStagingInputs({
    ...validEnvironment,
    AZURE_CLIENT_ID: "not-a-client-id",
    AZURE_TENANT_ID: "",
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /AZURE_CLIENT_ID must be a UUID/u);
  assert.match(result.violations.join("\n"), /AZURE_TENANT_ID must be a UUID/u);
});

test("rejects Internet-wide and overly broad SSH sources", () => {
  for (const source of ["0.0.0.0/0", "203.0.113.0/16", "*"]) {
    const result = validateAzureStagingInputs({
      ...validEnvironment,
      AZURE_STAGING_SSH_SOURCE_CIDR: source,
    });

    assert.equal(result.ok, false, source);
    assert.match(result.violations.join("\n"), /between \/24 and \/32/u);
  }
});

test("rejects missing host identity and budget notification inputs", () => {
  const result = validateAzureStagingInputs({
    ...validEnvironment,
    AZURE_STAGING_SSH_PUBLIC_KEY: "",
    AZURE_BUDGET_CONTACT_EMAIL: "",
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /public key/u);
  assert.match(result.violations.join("\n"), /notification address/u);
});

test("CLI failure never prints configured identity values", () => {
  const sensitiveCidr = "198.51.100.7/23";
  const sensitiveEmail = "private-operator@example.test";
  const result = spawnSync(process.execPath, [validatorPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...validEnvironment,
      AZURE_STAGING_SSH_SOURCE_CIDR: sensitiveCidr,
      AZURE_BUDGET_CONTACT_EMAIL: sensitiveEmail,
    },
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, new RegExp(sensitiveCidr.replace("/", "\\/"), "u"));
  assert.doesNotMatch(result.stderr, new RegExp(sensitiveEmail, "u"));
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SOLO_OPERATOR_CONFIRMATION } from "./verify-phase3-environment-protection.mjs";

const validatorPath = fileURLToPath(
  new URL("./validate-phase3-staging-inputs.mjs", import.meta.url),
);

function runValidator(overrides = {}) {
  return spawnSync(process.execPath, [validatorPath], {
    encoding: "utf8",
    env: {
      PHASE3_RUN_LIVE_PROVIDER: "false",
      PHASE3_STAGING_CHANGE_TICKET: "issue-14",
      PHASE3_STAGING_APPROVED_BUDGET_CAD: "4",
      GITHUB_RUN_ATTEMPT: "1",
      PHASE3_WORKFLOW_CONFIRMATION: "RUN_PHASE3_STAGING",
      ...overrides,
    },
  });
}

test("non-live validation does not require a solo-operator acknowledgement", () => {
  const result = runValidator();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /migration and durability only/u);
});

test("live validation accepts all three independent confirmations", () => {
  const result = runValidator({
    PHASE3_RUN_LIVE_PROVIDER: "true",
    PHASE3_SOLO_OPERATOR_CONFIRMATION: SOLO_OPERATOR_CONFIRMATION,
    PHASE3_STAGING_DESTRUCTIVE_CONFIRMATION:
      "PROVISION_MIGRATE_AND_DESTROY_SUPABASE_STAGING_DATABASE",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /solo-operator provider exit/u);
});

test("live validation rejects a missing solo-operator acknowledgement", () => {
  const result = runValidator({
    PHASE3_RUN_LIVE_PROVIDER: "true",
    PHASE3_STAGING_DESTRUCTIVE_CONFIRMATION:
      "PROVISION_MIGRATE_AND_DESTROY_SUPABASE_STAGING_DATABASE",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact solo-operator confirmation/u);
});

test("live validation rejects a near-match solo-operator acknowledgement", () => {
  const result = runValidator({
    PHASE3_RUN_LIVE_PROVIDER: "true",
    PHASE3_SOLO_OPERATOR_CONFIRMATION: `${SOLO_OPERATOR_CONFIRMATION}_TYPO`,
    PHASE3_STAGING_DESTRUCTIVE_CONFIRMATION:
      "PROVISION_MIGRATE_AND_DESTROY_SUPABASE_STAGING_DATABASE",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact solo-operator confirmation/u);
});

test("live budget rejects missing, zero, over-cap and malformed inputs without substituting measured cost", () => {
  const live = {
    PHASE3_RUN_LIVE_PROVIDER: "true",
    PHASE3_SOLO_OPERATOR_CONFIRMATION: SOLO_OPERATOR_CONFIRMATION,
    PHASE3_STAGING_DESTRUCTIVE_CONFIRMATION: "PROVISION_MIGRATE_AND_DESTROY_SUPABASE_STAGING_DATABASE",
  };
  for (const amount of [undefined, "", "0", "-1", "4.000001", "1e0", "NaN", "0.0000001"]) {
    assert.notEqual(runValidator({ ...live, PHASE3_STAGING_APPROVED_BUDGET_CAD: amount }).status, 0);
  }
  assert.equal(runValidator({ ...live, PHASE3_STAGING_APPROVED_BUDGET_CAD: "4.000000" }).status, 0);
  assert.notEqual(runValidator({ ...live, GITHUB_RUN_ATTEMPT: "2" }).status, 0);
  assert.notEqual(runValidator({ ...live, GITHUB_RUN_ATTEMPT: undefined }).status, 0);
  assert.equal(runValidator({ GITHUB_RUN_ATTEMPT: "2" }).status, 0);
  assert.notEqual(runValidator({ ...live, PHASE3_STAGING_MEASURED_COST_CAD: "4" }).status, 0);
  assert.equal(runValidator({ PHASE3_STAGING_APPROVED_BUDGET_CAD: undefined }).status, 0);
});

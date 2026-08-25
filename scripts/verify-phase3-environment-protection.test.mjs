import assert from "node:assert/strict";
import test from "node:test";

import {
  EnvironmentProtectionError,
  SOLO_OPERATOR_CONFIRMATION,
  buildEnvironmentApiUrl,
  evaluateEnvironmentProtection,
  verifyEnvironmentProtection,
} from "./verify-phase3-environment-protection.mjs";

function stagingEnvironment(overrides = {}) {
  return {
    name: "phase3-staging",
    can_admins_bypass: true,
    protection_rules: [],
    ...overrides,
  };
}

test("buildEnvironmentApiUrl encodes repository and environment path segments", () => {
  assert.equal(
    buildEnvironmentApiUrl({
      apiUrl: "https://github.example/api/v3/",
      environmentName: "phase3/staging",
      repository: "atoms/platform",
    }),
    "https://github.example/api/v3/repos/atoms/platform/environments/phase3%2Fstaging",
  );
});

test("evaluateEnvironmentProtection accepts an explicit solo-operator run", () => {
  assert.deepEqual(
    evaluateEnvironmentProtection(
      stagingEnvironment(),
      "phase3-staging",
      SOLO_OPERATOR_CONFIRMATION,
    ),
    {
      ok: true,
      violations: [],
    },
  );
});

test("evaluateEnvironmentProtection rejects a missing solo acknowledgement", () => {
  const result = evaluateEnvironmentProtection(
    stagingEnvironment(),
    "phase3-staging",
    undefined,
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, ["the exact solo-operator confirmation is missing"]);
});

test("evaluateEnvironmentProtection rejects a near-match solo acknowledgement", () => {
  const result = evaluateEnvironmentProtection(
    stagingEnvironment(),
    "phase3-staging",
    `${SOLO_OPERATOR_CONFIRMATION}_TYPO`,
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, ["the exact solo-operator confirmation is missing"]);
});

test("evaluateEnvironmentProtection always rejects the wrong environment", () => {
  const result = evaluateEnvironmentProtection(
    stagingEnvironment({ name: "production" }),
    "phase3-staging",
    SOLO_OPERATOR_CONFIRMATION,
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [
    "the returned environment name does not match the requested environment",
  ]);
});

test("verifyEnvironmentProtection does not expose response bodies on HTTP failure", async () => {
  const secretResponseBody = "provider-secret-value";

  await assert.rejects(
    verifyEnvironmentProtection({
      environmentName: "phase3-staging",
      repository: "atoms/platform",
      soloOperatorConfirmation: SOLO_OPERATOR_CONFIRMATION,
      token: "github-token-value",
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers.Authorization, "Bearer github-token-value");
        return {
          ok: false,
          status: 403,
          json: async () => ({ message: secretResponseBody }),
        };
      },
    }),
    (error) => {
      assert.ok(error instanceof EnvironmentProtectionError);
      assert.match(error.message, /HTTP 403/u);
      assert.doesNotMatch(error.message, new RegExp(secretResponseBody, "u"));
      assert.doesNotMatch(error.message, /github-token-value/u);
      return true;
    },
  );
});

test("verifyEnvironmentProtection returns only policy status", async () => {
  const result = await verifyEnvironmentProtection({
    environmentName: "phase3-staging",
    repository: "atoms/platform",
    soloOperatorConfirmation: SOLO_OPERATOR_CONFIRMATION,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => stagingEnvironment(),
    }),
  });

  assert.deepEqual(result, { ok: true, violations: [] });
  assert.equal("reviewers" in result, false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  EnvironmentProtectionError,
  buildEnvironmentApiUrl,
  evaluateEnvironmentProtection,
  verifyEnvironmentProtection,
} from "./verify-phase3-environment-protection.mjs";

function protectedEnvironment(overrides = {}) {
  return {
    name: "phase3-staging",
    can_admins_bypass: false,
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", reviewer: { id: 123, login: "redacted" } }],
      },
    ],
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

test("evaluateEnvironmentProtection accepts the complete fail-closed policy", () => {
  assert.deepEqual(evaluateEnvironmentProtection(protectedEnvironment(), "phase3-staging"), {
    ok: true,
    violations: [],
  });
});

test("evaluateEnvironmentProtection rejects a missing reviewer rule", () => {
  const result = evaluateEnvironmentProtection(
    protectedEnvironment({ protection_rules: [] }),
    "phase3-staging",
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, ["a required-reviewer rule is not configured"]);
});

test("evaluateEnvironmentProtection rejects empty reviewers and self-review", () => {
  const result = evaluateEnvironmentProtection(
    protectedEnvironment({
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [],
        },
      ],
    }),
    "phase3-staging",
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [
    "the required-reviewer rule has no reviewers",
    "self-review prevention is not enabled",
  ]);
});

test("evaluateEnvironmentProtection rejects administrator bypass", () => {
  const result = evaluateEnvironmentProtection(
    protectedEnvironment({ can_admins_bypass: true }),
    "phase3-staging",
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, ["administrator bypass is not disabled"]);
});

test("verifyEnvironmentProtection does not expose response bodies on HTTP failure", async () => {
  const secretResponseBody = "provider-secret-value";

  await assert.rejects(
    verifyEnvironmentProtection({
      environmentName: "phase3-staging",
      repository: "atoms/platform",
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
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => protectedEnvironment(),
    }),
  });

  assert.deepEqual(result, { ok: true, violations: [] });
  assert.equal("reviewers" in result, false);
});

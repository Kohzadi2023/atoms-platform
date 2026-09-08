import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_API_CLIENT_ID,
  EXPECTED_ISSUER,
  EXPECTED_SCOPE,
  EXPECTED_TENANT_ID,
  decodeJwtPayload,
  runEntraIdentitySmoke,
  validateEntraAccessTokenClaims,
} from "./smoke-staging-entra-auth.mjs";

function token(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function claims(overrides = {}) {
  return {
    tid: EXPECTED_TENANT_ID,
    iss: EXPECTED_ISSUER,
    aud: EXPECTED_API_CLIENT_ID,
    scp: EXPECTED_SCOPE,
    sub: "customer-1",
    exp: 2_000_000_000,
    ...overrides,
  };
}

test("decodes and validates the verified Atoms staging Entra token contract", () => {
  const accessToken = token(claims());
  const payload = decodeJwtPayload(accessToken);
  assert.deepEqual(validateEntraAccessTokenClaims(payload, 1_900_000_000), {
    subject: "customer-1",
  });
});

test("rejects the wrong tenant, issuer, audience, scope, or expiry", () => {
  for (const override of [
    { tid: "00000000-0000-0000-0000-000000000000" },
    { iss: "https://example.invalid/v2.0" },
    { aud: "wrong-api" },
    { scp: "openid profile" },
    { exp: 100 },
  ]) {
    assert.throws(
      () => validateEntraAccessTokenClaims(claims(override), 1_000),
      /Entra access token/u,
    );
  }
});

test("proves two distinct Entra identities are resolved by Control API", async () => {
  const primaryToken = token(claims({ sub: "customer-1" }));
  const foreignToken = token(claims({ sub: "customer-2" }));
  const fetch = async (url, init) => {
    const authorization = init.headers.authorization;
    return {
      status: 200,
      async json() {
        return {
          userId: authorization === `Bearer ${primaryToken}` ? "user-primary" : "user-foreign",
          memberships: [{ role: "MEMBER", workspace: { id: "workspace" } }],
        };
      },
    };
  };

  const result = await runEntraIdentitySmoke(
    {
      controlApiOrigin: "https://control.example.test",
      primaryToken,
      foreignToken,
    },
    { fetch },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, [
    "verified_entra_token_contract",
    "two_distinct_entra_subjects",
    "control_api_resolves_both_identities",
  ]);
});

test("fails closed when two tokens represent the same Entra subject", async () => {
  const primaryToken = token(claims({ sub: "same-customer" }));
  const foreignToken = token(claims({ sub: "same-customer" }));

  await assert.rejects(
    runEntraIdentitySmoke({
      controlApiOrigin: "https://control.example.test",
      primaryToken,
      foreignToken,
    }),
    /two distinct customer identities/u,
  );
});

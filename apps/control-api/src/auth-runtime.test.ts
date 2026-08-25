import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuthRuntimeOptions } from "./auth-runtime.js";

test("production startup rejects AUTH_REQUIRED=false", () => {
  assert.throws(
    () =>
      resolveAuthRuntimeOptions({
        NODE_ENV: "production",
        AUTH_REQUIRED: false,
        AUTH_ISSUER_URL: undefined,
        AUTH_AUDIENCE: undefined,
        AUTH_JWKS_URL: undefined,
        AUTH_ALLOWED_ALGORITHMS: ["RS256"],
        AUTH_DEV_AUTHENTICATOR_ENABLED: false,
        AUTH_DEV_ACCESS_TOKEN: "dev-access-token",
        AUTH_DEV_USER_ID: "dev-user",
      }),
    /AUTH_REQUIRED must remain true in production/u,
  );
});

test("production startup rejects explicit development authenticator", () => {
  assert.throws(
    () =>
      resolveAuthRuntimeOptions({
        NODE_ENV: "production",
        AUTH_REQUIRED: true,
        AUTH_ISSUER_URL: "https://issuer.example.test/",
        AUTH_AUDIENCE: "atoms-control-api",
        AUTH_JWKS_URL: "https://issuer.example.test/.well-known/jwks.json",
        AUTH_ALLOWED_ALGORITHMS: ["RS256"],
        AUTH_DEV_AUTHENTICATOR_ENABLED: true,
        AUTH_DEV_ACCESS_TOKEN: "dev-access-token",
        AUTH_DEV_USER_ID: "dev-user",
      }),
    /cannot be used in production/u,
  );
});

test("development authenticator requires an explicit access token", () => {
  assert.throws(
    () =>
      resolveAuthRuntimeOptions({
        NODE_ENV: "development",
        AUTH_REQUIRED: true,
        AUTH_ISSUER_URL: undefined,
        AUTH_AUDIENCE: undefined,
        AUTH_JWKS_URL: undefined,
        AUTH_ALLOWED_ALGORITHMS: ["RS256"],
        AUTH_DEV_AUTHENTICATOR_ENABLED: true,
        AUTH_DEV_ACCESS_TOKEN: undefined,
        AUTH_DEV_USER_ID: "local-demo-user",
      }),
    /AUTH_DEV_ACCESS_TOKEN is required/u,
  );
});

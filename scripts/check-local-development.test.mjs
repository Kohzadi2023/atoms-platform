import assert from "node:assert/strict";
import test from "node:test";

import { evaluateLocalDevelopmentEnvironment } from "./check-local-development.mjs";

const DEVELOPMENT_TOKEN = "0123456789abcdef0123456789abcdef";

function validEnvironment(overrides = {}) {
  return {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://local/database",
    REDIS_URL: "redis://localhost:6379",
    OPENAI_API_KEY: "configured-openai-key",
    E2B_API_KEY: "configured-e2b-key",
    PREVIEW_SIGNING_SECRET: "0123456789abcdef0123456789abcdef",
    PREVIEW_BASE_DOMAIN: "preview.localhost",
    PREVIEW_UI_ORIGIN: "http://localhost:3000",
    S3_BUCKET: "atoms-attachments",
    S3_REGION: "us-east-1",
    S3_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY_ID: "local-access-key",
    S3_SECRET_ACCESS_KEY: "local-secret-key",
    CLAMAV_HOST: "127.0.0.1",
    AUTH_REQUIRED: "true",
    AUTH_DEV_AUTHENTICATOR_ENABLED: "true",
    AUTH_DEV_ACCESS_TOKEN: DEVELOPMENT_TOKEN,
    NEXT_PUBLIC_CONTROL_API_ACCESS_TOKEN: DEVELOPMENT_TOKEN,
    ...overrides,
  };
}

test("accepts a complete development-token configuration", () => {
  assert.deepEqual(evaluateLocalDevelopmentEnvironment(validEnvironment()), {
    ok: true,
    violations: [],
  });
});

test("reports missing provider variables by name", () => {
  const result = evaluateLocalDevelopmentEnvironment(
    validEnvironment({ OPENAI_API_KEY: "", E2B_API_KEY: undefined }),
  );

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /OPENAI_API_KEY, E2B_API_KEY/u);
});

test("rejects mismatched development tokens without exposing either value", () => {
  const apiToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const browserToken = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const result = evaluateLocalDevelopmentEnvironment(
    validEnvironment({
      AUTH_DEV_ACCESS_TOKEN: apiToken,
      NEXT_PUBLIC_CONTROL_API_ACCESS_TOKEN: browserToken,
    }),
  );
  const output = JSON.stringify(result);

  assert.equal(result.ok, false);
  assert.match(output, /tokens must match/u);
  assert.doesNotMatch(output, new RegExp(apiToken, "u"));
  assert.doesNotMatch(output, new RegExp(browserToken, "u"));
});

test("accepts a complete Supabase OIDC configuration", () => {
  const result = evaluateLocalDevelopmentEnvironment(
    validEnvironment({
      AUTH_DEV_AUTHENTICATOR_ENABLED: "false",
      AUTH_DEV_ACCESS_TOKEN: undefined,
      NEXT_PUBLIC_CONTROL_API_ACCESS_TOKEN: undefined,
      AUTH_ISSUER_URL: "https://project.supabase.co/auth/v1",
      AUTH_AUDIENCE: "authenticated",
      AUTH_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key-long-enough",
    }),
  );

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("rejects placeholder Supabase configuration", () => {
  const result = evaluateLocalDevelopmentEnvironment(
    validEnvironment({
      AUTH_DEV_AUTHENTICATOR_ENABLED: "false",
      AUTH_DEV_ACCESS_TOKEN: undefined,
      NEXT_PUBLIC_CONTROL_API_ACCESS_TOKEN: undefined,
      AUTH_ISSUER_URL: "https://your-project-ref.supabase.co/auth/v1",
      AUTH_AUDIENCE: "authenticated",
      AUTH_JWKS_URL:
        "https://your-project-ref.supabase.co/auth/v1/.well-known/jwks.json",
      NEXT_PUBLIC_SUPABASE_URL: "https://your-project-ref.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined,
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /provide OIDC variables/u);
});

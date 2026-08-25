import assert from "node:assert/strict";
import test from "node:test";

import {
  createSupabaseAccessTokenProvider,
  resolveBrowserAuthenticationMode,
} from "./supabase-auth.js";

test("Supabase configuration is selected and normalized as the production IdP", () => {
  const mode = resolveBrowserAuthenticationMode({
    nodeEnv: "production",
    supabaseUrl: " https://project-ref.supabase.co/ ",
    supabasePublishableKey: " publishable-test-key-with-safe-length ",
  });

  assert.deepEqual(mode, {
    kind: "supabase",
    configuration: {
      url: "https://project-ref.supabase.co",
      publishableKey: "publishable-test-key-with-safe-length",
    },
  });
});

test("production fails closed when Supabase configuration is missing or partial", () => {
  assert.equal(
    resolveBrowserAuthenticationMode({
      nodeEnv: "production",
      supabaseUrl: undefined,
      supabasePublishableKey: undefined,
    }).kind,
    "configuration_error",
  );
  assert.equal(
    resolveBrowserAuthenticationMode({
      nodeEnv: "production",
      supabaseUrl: "https://project-ref.supabase.co",
      supabasePublishableKey: undefined,
    }).kind,
    "configuration_error",
  );
});

test("development can retain the explicit static-token authenticator fallback", () => {
  assert.deepEqual(
    resolveBrowserAuthenticationMode({
      nodeEnv: "development",
      supabaseUrl: undefined,
      supabasePublishableKey: undefined,
    }),
    { kind: "development" },
  );
});

test("Supabase access token provider returns the current short-lived token", async () => {
  const provider = createSupabaseAccessTokenProvider({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "  current-access-token  " } },
        error: null,
      }),
    },
  });

  assert.equal(await provider(), "current-access-token");
});

test("Supabase access token provider stays unauthenticated without a session", async () => {
  const provider = createSupabaseAccessTokenProvider({
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
    },
  });

  assert.equal(await provider(), undefined);
});

test("Supabase access token provider fails closed on session errors", async () => {
  const provider = createSupabaseAccessTokenProvider({
    auth: {
      getSession: async () => ({
        data: { session: null },
        error: { message: "session storage failed" },
      }),
    },
  });

  await assert.rejects(
    async () => provider(),
    /Supabase session could not be loaded/u,
  );
});

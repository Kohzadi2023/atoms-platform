import assert from "node:assert/strict";
import test from "node:test";

import {
  createEntraAccessTokenProvider,
  createEntraRedirectUri,
  resolveBrowserAuthenticationMode,
} from "./entra-auth.js";

test("Entra External ID configuration is selected and normalized in production", () => {
  const mode = resolveBrowserAuthenticationMode({
    nodeEnv: "production",
    clientId: "11111111-2222-4333-8444-555555555555",
    authority: " https://atoms.ciamlogin.com/ ",
    tenantId: " AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE ",
    apiScope: " api://66666666-7777-4888-8999-aaaaaaaaaaaa/access_as_user ",
  });

  assert.deepEqual(mode, {
    kind: "entra",
    configuration: {
      clientId: "11111111-2222-4333-8444-555555555555",
      authority: "https://atoms.ciamlogin.com/",
      tenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      knownAuthorities: [
        "atoms.ciamlogin.com",
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.ciamlogin.com",
      ],
      apiScope: "api://66666666-7777-4888-8999-aaaaaaaaaaaa/access_as_user",
    },
  });
});

test("CIAM GUID issuer authority is deduplicated when it matches the configured authority host", () => {
  const mode = resolveBrowserAuthenticationMode({
    nodeEnv: "production",
    clientId: "11111111-2222-4333-8444-555555555555",
    authority: "https://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.ciamlogin.com/",
    tenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    apiScope: "api://66666666-7777-4888-8999-aaaaaaaaaaaa/access_as_user",
  });

  assert.equal(mode.kind, "entra");
  if (mode.kind !== "entra") return;
  assert.deepEqual(mode.configuration.knownAuthorities, [
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.ciamlogin.com",
  ]);
});

test("production fails closed when Entra configuration is missing or partial", () => {
  assert.equal(
    resolveBrowserAuthenticationMode({
      nodeEnv: "production",
      clientId: undefined,
      authority: undefined,
      tenantId: undefined,
      apiScope: undefined,
    }).kind,
    "configuration_error",
  );

  assert.equal(
    resolveBrowserAuthenticationMode({
      nodeEnv: "production",
      clientId: "11111111-2222-4333-8444-555555555555",
      authority: "https://atoms.ciamlogin.com/",
      tenantId: undefined,
      apiScope: "api://66666666-7777-4888-8999-aaaaaaaaaaaa/access_as_user",
    }).kind,
    "configuration_error",
  );
});

test("production rejects an invalid Entra tenant ID", () => {
  const mode = resolveBrowserAuthenticationMode({
    nodeEnv: "production",
    clientId: "11111111-2222-4333-8444-555555555555",
    authority: "https://atoms.ciamlogin.com/",
    tenantId: "not-a-guid",
    apiScope: "api://66666666-7777-4888-8999-aaaaaaaaaaaa/access_as_user",
  });

  assert.deepEqual(mode, {
    kind: "configuration_error",
    message: "NEXT_PUBLIC_ENTRA_TENANT_ID must be a Microsoft Entra tenant ID GUID.",
  });
});

test("development can retain the explicit static-token authenticator fallback", () => {
  assert.deepEqual(
    resolveBrowserAuthenticationMode({
      nodeEnv: "development",
      clientId: undefined,
      authority: undefined,
      tenantId: undefined,
      apiScope: undefined,
    }),
    { kind: "development" },
  );
});

test("MSAL v5 uses the dedicated redirect bridge route", () => {
  assert.equal(
    createEntraRedirectUri("https://atoms.example.test/workspace?ignored=true#ignored"),
    "https://atoms.example.test/redirect",
  );
});

test("Entra access token provider returns the current short-lived API token", async () => {
  const account = { homeAccountId: "account-1" };
  const provider = createEntraAccessTokenProvider(
    {
      acquireTokenSilent: async (request) => {
        assert.equal(request.account, account);
        assert.deepEqual(request.scopes, [
          "api://66666666-7777-4888-8999-aaaaaaaaaaaa/access_as_user",
        ]);
        return { accessToken: "  current-access-token  " };
      },
    },
    account,
    "api://66666666-7777-4888-8999-aaaaaaaaaaaa/access_as_user",
  );

  assert.equal(await provider(), "current-access-token");
});

test("Entra access token provider stays unauthenticated for an empty token", async () => {
  const provider = createEntraAccessTokenProvider(
    {
      acquireTokenSilent: async () => ({ accessToken: "   " }),
    },
    { homeAccountId: "account-1" },
    "api://66666666-7777-4888-8999-aaaaaaaaaaaa/access_as_user",
  );

  assert.equal(await provider(), undefined);
});

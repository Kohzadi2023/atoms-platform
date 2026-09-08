import assert from "node:assert/strict";
import test from "node:test";

import {
  createEntraAccessTokenProvider,
  resolveBrowserAuthenticationMode,
} from "./entra-auth.js";

test("Entra External ID configuration is selected and normalized in production", () => {
  const mode = resolveBrowserAuthenticationMode({
    nodeEnv: "production",
    clientId: "11111111-2222-4333-8444-555555555555",
    authority: " https://atoms.ciamlogin.com/ ",
    apiScope: " api://66666666-7777-4888-8999-aaaaaaaaaaaa/access_as_user ",
  });

  assert.deepEqual(mode, {
    kind: "entra",
    configuration: {
      clientId: "11111111-2222-4333-8444-555555555555",
      authority: "https://atoms.ciamlogin.com/",
      knownAuthority: "atoms.ciamlogin.com",
      apiScope: "api://66666666-7777-4888-8999-aaaaaaaaaaaa/access_as_user",
    },
  });
});

test("production fails closed when Entra configuration is missing or partial", () => {
  assert.equal(
    resolveBrowserAuthenticationMode({
      nodeEnv: "production",
      clientId: undefined,
      authority: undefined,
      apiScope: undefined,
    }).kind,
    "configuration_error",
  );

  assert.equal(
    resolveBrowserAuthenticationMode({
      nodeEnv: "production",
      clientId: "11111111-2222-4333-8444-555555555555",
      authority: "https://atoms.ciamlogin.com/",
      apiScope: undefined,
    }).kind,
    "configuration_error",
  );
});

test("development can retain the explicit static-token authenticator fallback", () => {
  assert.deepEqual(
    resolveBrowserAuthenticationMode({
      nodeEnv: "development",
      clientId: undefined,
      authority: undefined,
      apiScope: undefined,
    }),
    { kind: "development" },
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

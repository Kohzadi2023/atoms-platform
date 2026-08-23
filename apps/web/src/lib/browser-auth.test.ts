import assert from "node:assert/strict";
import test from "node:test";

import { createDevelopmentAccessTokenProvider } from "./browser-auth.js";

test("development token provider returns an explicitly configured token", async () => {
  const provider = createDevelopmentAccessTokenProvider({
    nodeEnv: "development",
    configuredToken: "  local-development-access-token-1234  ",
  });

  assert.equal(await provider(), "local-development-access-token-1234");
});

test("production rejects a browser-visible static access token", () => {
  assert.throws(
    () =>
      createDevelopmentAccessTokenProvider({
        nodeEnv: "production",
        configuredToken: "local-development-access-token-1234",
      }),
    /development-only and cannot be used in production/u,
  );
});

test("production without an injected identity provider remains unauthenticated", async () => {
  const provider = createDevelopmentAccessTokenProvider({
    nodeEnv: "production",
    configuredToken: undefined,
  });

  assert.equal(await provider(), undefined);
});

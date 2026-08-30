import assert from "node:assert/strict";
import test from "node:test";

import { buildContentSecurityPolicy } from "./content-security-policy.js";

test("CSP allows only the exact API, Supabase, and storage origins", () => {
  const policy = buildContentSecurityPolicy({
    controlApiUrl: "https://api.staging.atoms.dev/v1",
    supabaseUrl: "https://fixture-project.supabase.co/path",
    storageUrl: "https://storage.staging.atoms.dev/atoms-attachments",
    previewBaseDomain: "preview.staging.atoms.dev",
  });

  assert.match(
    policy,
    /connect-src 'self' https:\/\/api\.staging\.atoms\.dev https:\/\/fixture-project\.supabase\.co https:\/\/storage\.staging\.atoms\.dev/u,
  );
  assert.match(
    policy,
    /frame-src https:\/\/preview\.staging\.atoms\.dev https:\/\/\*\.preview\.staging\.atoms\.dev/u,
  );
  assert.doesNotMatch(policy, /connect-src[^;]*\*/u);
});

test("CSP permits HTTP only for local development origins", () => {
  assert.doesNotThrow(() =>
    buildContentSecurityPolicy({
      controlApiUrl: "http://127.0.0.1:3001",
      storageUrl: "http://localhost:9000",
    }),
  );
  assert.throws(
    () =>
      buildContentSecurityPolicy({
        controlApiUrl: "https://api.staging.atoms.dev",
        storageUrl: "http://storage.staging.atoms.dev",
      }),
    /NEXT_PUBLIC_STORAGE_ORIGIN must use HTTPS/u,
  );
});

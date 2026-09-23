import assert from "node:assert/strict";
import test from "node:test";

import { CLIENT_PORTAL_TESTABILITY_CONTRACT } from "@atoms/agents";
import { AcceptanceManifestSchema } from "@atoms/sandbox-provider";

import {
  CLIENT_PORTAL_ACCEPTANCE_MANIFEST,
  CLIENT_PORTAL_CRITERION_IDS_BY_SCENARIO,
  getAcceptanceManifest,
} from "./acceptance-manifest.js";

test("GENERAL projects get no acceptance manifest; CLIENT_PORTAL gets the real one", () => {
  assert.equal(getAcceptanceManifest("GENERAL"), null);
  assert.equal(getAcceptanceManifest("CLIENT_PORTAL"), CLIENT_PORTAL_ACCEPTANCE_MANIFEST);
});

test("the shipped manifest is schema-valid", () => {
  AcceptanceManifestSchema.parse(CLIENT_PORTAL_ACCEPTANCE_MANIFEST);
});

// G3 / issue #130: this file and packages/agents/src/manifests.ts (Bob's,
// Alex's and David's live instructions) must quote the exact same constants,
// or the acceptance scenarios would target routes and testids the generated
// app was never told to produce.
test("every route, testid and fixture credential in the manifest comes from the shared testability contract, not a hardcoded copy", () => {
  const contract = CLIENT_PORTAL_TESTABILITY_CONTRACT;
  const authFlow = CLIENT_PORTAL_ACCEPTANCE_MANIFEST.scenarios.find(
    (scenario): scenario is Extract<typeof scenario, { kind: "AUTH_FLOW" }> => scenario.kind === "AUTH_FLOW",
  );
  assert.ok(authFlow, "the manifest must have an AUTH_FLOW scenario");
  assert.equal(authFlow.loginPath, contract.routes.login);
  assert.equal(authFlow.expectPathAfterLogin, contract.routes.dashboard);
  assert.equal(authFlow.usernameSelector, `[data-testid="${contract.testIds.loginEmail}"]`);
  assert.equal(authFlow.passwordSelector, `[data-testid="${contract.testIds.loginPassword}"]`);
  assert.equal(authFlow.submitSelector, `[data-testid="${contract.testIds.loginSubmit}"]`);
  assert.equal(authFlow.username, contract.fixtureAccounts.tenantA.clientEmail);
  assert.equal(authFlow.password, contract.fixtureAccounts.password);

  const signedOutJourney = CLIENT_PORTAL_ACCEPTANCE_MANIFEST.scenarios.find(
    (scenario) => scenario.name === "signed-out-visitor-blocked",
  );
  assert.ok(signedOutJourney && signedOutJourney.kind === "PRIMARY_JOURNEY");
  assert.deepEqual(signedOutJourney.steps, [
    { action: "goto", path: contract.routes.dashboard },
    { action: "expectPath", path: contract.routes.login },
  ]);
});

test("scenario names are unique (the manifest schema itself would reject a duplicate)", () => {
  const names = CLIENT_PORTAL_ACCEPTANCE_MANIFEST.scenarios.map((scenario) => scenario.name);
  assert.equal(new Set(names).size, names.length);
});

// Documents the known, deliberate gap rather than letting it be discovered by
// a run silently staying BLOCKED with no explanation in this codebase.
test("the criterion map stays empty until a human assigns real, per-run criterion ids", () => {
  assert.deepEqual(CLIENT_PORTAL_CRITERION_IDS_BY_SCENARIO, {});
});

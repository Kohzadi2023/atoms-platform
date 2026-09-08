import assert from "node:assert/strict";
import test from "node:test";

import {
  ENTRA_STAGING_BOUNDARY,
  ENTRA_TENANT_APPLY_CONFIRMATION,
  ENTRA_TENANT_PLAN_CONFIRMATION,
  buildCheckNameUrl,
  buildNameCheckBody,
  buildTenantCreateBody,
  buildTenantUrl,
  parseArguments,
} from "./bootstrap-entra-external-tenant.mjs";

test("plan mode requires the exact acknowledgement", () => {
  const options = parseArguments([
    "--mode",
    "plan",
    "--confirmation",
    ENTRA_TENANT_PLAN_CONFIRMATION,
  ]);

  assert.deepEqual(options, {
    mode: "plan",
    confirmation: ENTRA_TENANT_PLAN_CONFIRMATION,
  });
});

test("apply mode requires a stronger acknowledgement", () => {
  const options = parseArguments([
    "--mode",
    "apply",
    "--confirmation",
    ENTRA_TENANT_APPLY_CONFIRMATION,
  ]);

  assert.deepEqual(options, {
    mode: "apply",
    confirmation: ENTRA_TENANT_APPLY_CONFIRMATION,
  });

  assert.throws(
    () =>
      parseArguments([
        "--mode",
        "apply",
        "--confirmation",
        ENTRA_TENANT_PLAN_CONFIRMATION,
      ]),
    /CREATE_ATOMS_ENTRA_EXTERNAL_TENANT/u,
  );
});

test("all Azure URLs are pinned to the dedicated Atoms subscription", () => {
  const checkUrl = buildCheckNameUrl();
  const tenantUrl = buildTenantUrl("atomsstaging91ce9");

  for (const url of [checkUrl, tenantUrl]) {
    assert.match(url, new RegExp(ENTRA_STAGING_BOUNDARY.subscriptionId, "u"));
    assert.doesNotMatch(
      url,
      new RegExp(ENTRA_STAGING_BOUNDARY.forbiddenSubscriptionId, "u"),
    );
  }

  assert.match(tenantUrl, /resourceGroups\/atoms-staging-rg/u);
});

test("name availability payload keeps the Canadian tenant country code", () => {
  assert.deepEqual(buildNameCheckBody("atomsstaging91ce9"), {
    name: "atomsstaging91ce9",
    countryCode: "CA",
  });
});

test("create payload is the supported External ID CIAM resource shape", () => {
  assert.deepEqual(buildTenantCreateBody("atomsstaging91ce9"), {
    location: "United States",
    sku: { name: "Standard", tier: "A0" },
    properties: {
      createTenantProperties: {
        displayName: "Atoms Staging Customers",
        countryCode: "CA",
      },
    },
    tags: {
      project: "atoms",
      environment: "staging",
      purpose: "customer-identity",
    },
  });
});

test("tenant resource names are constrained to the ARM contract", () => {
  assert.throws(() => buildTenantUrl("atoms-staging"), /alphanumeric/u);
  assert.throws(() => buildTenantCreateBody("a".repeat(27)), /1-26/u);
});

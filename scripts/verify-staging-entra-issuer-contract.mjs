import assert from "node:assert/strict";

import {
  EXPECTED_ISSUER,
  EXPECTED_TENANT_ID,
} from "./smoke-staging-entra-auth.mjs";

const expected = `https://${EXPECTED_TENANT_ID}.ciamlogin.com/${EXPECTED_TENANT_ID}/v2.0`;
assert.equal(EXPECTED_ISSUER, expected);
console.log("External ID staging issuer contract verified.");

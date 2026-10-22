import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkVersionBump, compareVersions, parseVersion } from "./check-version-bump.mjs";

test("accepts a higher patch, minor or major version", () => {
  assert.equal(checkVersionBump("0.1.0", "0.1.1").ok, true);
  assert.equal(checkVersionBump("0.1.9", "0.2.0").ok, true);
  assert.equal(checkVersionBump("0.9.9", "1.0.0").ok, true);
});

test("rejects an unchanged or lower version", () => {
  assert.equal(checkVersionBump("0.1.1", "0.1.1").ok, false);
  assert.equal(checkVersionBump("0.1.1", "0.1.0").ok, false);
  assert.equal(checkVersionBump("1.0.0", "0.9.9").ok, false);
});

test("compares numerically, not as text", () => {
  assert.equal(checkVersionBump("0.1.9", "0.1.10").ok, true);
  assert.equal(checkVersionBump("0.1.10", "0.1.9").ok, false);
  assert.ok(compareVersions([0, 10, 0], [0, 9, 0]) > 0);
});

test("rejects versions that are not MAJOR.MINOR.PATCH", () => {
  assert.equal(parseVersion("1.2"), undefined);
  assert.equal(parseVersion("1.2.3-beta"), undefined);
  assert.equal(parseVersion("v1.2.3"), undefined);
  assert.equal(checkVersionBump("0.1.0", "next").ok, false);
  assert.equal(checkVersionBump("latest", "0.1.1").ok, false);
});

test("the failure message tells the author what to do", () => {
  const result = checkVersionBump("0.1.1", "0.1.1");
  assert.match(result.reason, /greater than 0\.1\.1/u);
  assert.match(result.reason, /raise the patch number/u);
});

test("CI runs the check on pull requests only, with the base commit", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /version-bump:/u);
  assert.match(workflow, /if: github\.event_name == 'pull_request'/u);
  assert.match(workflow, /node scripts\/check-version-bump\.mjs "\$BASE_SHA"/u);
});

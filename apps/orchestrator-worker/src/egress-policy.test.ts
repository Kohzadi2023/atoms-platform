import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { parseEgressAllowedHosts } from "./egress-policy.js";

const DEFAULT_HOSTS = "registry.npmjs.org,binaries.prisma.sh";

test("the configured list comes out exactly, trimmed and de-duplicated", () => {
  assert.deepEqual(parseEgressAllowedHosts(DEFAULT_HOSTS), [
    "registry.npmjs.org",
    "binaries.prisma.sh",
  ]);
  assert.deepEqual(
    parseEgressAllowedHosts(" registry.npmjs.org , registry.npmjs.org,, Binaries.Prisma.sh "),
    ["registry.npmjs.org", "binaries.prisma.sh"],
  );
});

test("an empty list means no egress at all", () => {
  assert.deepEqual(parseEgressAllowedHosts(""), []);
  assert.deepEqual(parseEgressAllowedHosts(" , "), []);
});

test("wildcards are refused, so the list can never widen to a whole domain", () => {
  for (const value of ["*", "*.npmjs.org", "registry.npmjs.org,*.com"]) {
    assert.throws(() => parseEgressAllowedHosts(value), /wildcard/);
  }
});

test("IP literals and single-label names are refused", () => {
  assert.throws(() => parseEgressAllowedHosts("169.254.169.254"), /IP address/);
  assert.throws(() => parseEgressAllowedHosts("0.0.0.0"), /IP address/);
  assert.throws(() => parseEgressAllowedHosts("localhost"), /fully qualified/);
});

test("anything that is not a bare hostname is refused", () => {
  for (const value of [
    "https://registry.npmjs.org",
    "registry.npmjs.org/path",
    "registry.npmjs.org:443",
    "10.0.0.0/8",
    "bad host.example.com",
  ]) {
    assert.throws(() => parseEgressAllowedHosts(value), RangeError, value);
  }
});

test("the worker takes both sandbox allowlists only from the parsed configuration", async () => {
  const source = await readFile(resolve(process.cwd(), "src/main.ts"), "utf8");

  assert.equal(
    source.match(/parseEgressAllowedHosts\(environment\.E2B_ALLOWED_HOSTS\)/gu)?.length,
    3,
    "startup validation plus the validation runner and the migration runner",
  );
  assert.doesNotMatch(source, /E2B_ALLOWED_HOSTS\.split/u);
  assert.match(source, /allowedHosts: parseEgressAllowedHosts\(/u);
  assert.match(source, /packageHosts: parseEgressAllowedHosts\(/u);
});

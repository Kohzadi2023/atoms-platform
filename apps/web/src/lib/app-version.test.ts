import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { formatAppVersion } from "./app-version.js";

test("formats a valid build version for the footer", () => {
  assert.equal(formatAppVersion("0.1.0"), "Atoms v0.1.0");
  assert.equal(formatAppVersion(" 1.12.3 "), "Atoms v1.12.3");
});

test("falls back to dev instead of showing a malformed version", () => {
  assert.equal(formatAppVersion(undefined), "Atoms dev");
  assert.equal(formatAppVersion(""), "Atoms dev");
  assert.equal(formatAppVersion("1.2"), "Atoms dev");
  assert.equal(formatAppVersion("1.2.3-beta"), "Atoms dev");
});

test("every page renders the footer and the build injects the root version", async () => {
  const layout = await readFile(resolve(process.cwd(), "app/layout.tsx"), "utf8");
  const config = await readFile(resolve(process.cwd(), "next.config.ts"), "utf8");

  assert.match(layout, /<AppVersionFooter \/>/u);
  assert.match(config, /\.\.\/\.\.\/package\.json/u);
  assert.match(config, /NEXT_PUBLIC_APP_VERSION: appVersion/u);
});

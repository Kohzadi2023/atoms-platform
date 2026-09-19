import assert from "node:assert/strict";
import test from "node:test";

import { Template } from "@e2b/code-interpreter";

import {
  DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
  DEFAULT_PLAYWRIGHT_ENTRY,
  VIABILITY_DIRECTORY,
  VIABILITY_PLAYWRIGHT_VERSION,
  buildViabilityTemplate,
} from "./viability-template.js";

interface TemplateJson {
  readonly fromTemplate?: string;
  readonly steps: ReadonlyArray<{
    readonly type: string;
    readonly args: readonly string[];
  }>;
}

// A template built on another template cannot be turned into a Dockerfile, so the
// JSON form the E2B API receives is what is inspected.
async function describe(base = "atoms-nextjs"): Promise<TemplateJson> {
  return JSON.parse(await Template.toJSON(buildViabilityTemplate(base), false));
}

test("the template layers on the existing validation template instead of replacing it", async () => {
  const template = await describe("atoms-nextjs");

  assert.equal(template.fromTemplate, "atoms-nextjs");
});

test("Playwright is installed at the path the runner defaults to, at a pinned exact version", async () => {
  const template = await describe();
  const install = template.steps.find((step) => step.type === "RUN")?.args[0] ?? "";

  assert.ok(DEFAULT_PLAYWRIGHT_ENTRY.startsWith(`${VIABILITY_DIRECTORY}/node_modules/playwright/`));
  assert.ok(install.includes(`cd ${VIABILITY_DIRECTORY} && npm init -y`));
  assert.ok(install.includes(`playwright@${VIABILITY_PLAYWRIGHT_VERSION}`));
  assert.ok(install.includes("npx playwright install --with-deps chromium"));
  assert.match(VIABILITY_PLAYWRIGHT_VERSION, /^\d+\.\d+\.\d+$/, "an exact version, not a range");
});

test("the install runs as root, and what it installs is readable by the sandbox user", async () => {
  const template = await describe();
  const run = template.steps.find((step) => step.type === "RUN");

  assert.equal(run?.args[1], "root");
  assert.ok((run?.args[0] ?? "").includes(`chmod -R a+rX ${VIABILITY_DIRECTORY}`));
});

test("browsers go to the shared path, set before the install so Playwright uses it", async () => {
  const template = await describe();
  const envIndex = template.steps.findIndex(
    (step) =>
      step.type === "ENV" &&
      step.args[0] === "PLAYWRIGHT_BROWSERS_PATH" &&
      step.args[1] === DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
  );
  const runIndex = template.steps.findIndex((step) => step.type === "RUN");

  assert.ok(DEFAULT_PLAYWRIGHT_BROWSERS_PATH.startsWith(`${VIABILITY_DIRECTORY}/`));
  assert.ok(envIndex >= 0, "the ENV step is present");
  assert.ok(envIndex < runIndex, "the ENV step comes before the install");
});

test("a blank base template name is refused", () => {
  assert.throws(() => buildViabilityTemplate("  "), RangeError);
});

import assert from "node:assert/strict";
import test from "node:test";

import { Template } from "@e2b/code-interpreter";

import { BASE_TEMPLATE_PNPM_VERSION, buildBaseTemplate } from "./base-template.js";

interface TemplateJson {
  readonly fromTemplate?: string;
  readonly steps: ReadonlyArray<{
    readonly type: string;
    readonly args: readonly string[];
  }>;
}

async function describe(): Promise<TemplateJson> {
  return JSON.parse(await Template.toJSON(buildBaseTemplate(), false));
}

test("the template starts from a Node.js image, not an existing E2B template", async () => {
  const template = await describe();

  assert.equal(template.fromTemplate, undefined);
});

test("pnpm is activated via corepack, at the monorepo's pinned version, as root", async () => {
  const template = await describe();
  const run = template.steps.find((step) => step.type === "RUN");
  const install = run?.args[0] ?? "";

  assert.ok(install.includes("corepack enable"));
  assert.ok(install.includes(`corepack prepare pnpm@${BASE_TEMPLATE_PNPM_VERSION} --activate`));
  assert.equal(run?.args[1], "root");
  assert.match(BASE_TEMPLATE_PNPM_VERSION, /^\d+\.\d+\.\d+$/, "an exact version, not a range");
});

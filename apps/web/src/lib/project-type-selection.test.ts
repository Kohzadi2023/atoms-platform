import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { ProjectTypeSchema } from "@atoms/contracts";

import {
  PROJECT_TYPE_OPTIONS,
  projectTypeOption,
} from "./project-type-selection.js";

test("the selector exposes every project type exactly once", () => {
  assert.deepEqual(
    PROJECT_TYPE_OPTIONS.map(({ value }) => value).sort(),
    [...ProjectTypeSchema.options].sort(),
  );
});

test("GENERAL preserves the full application route and CLIENT_PORTAL explains its narrower route", () => {
  assert.match(projectTypeOption("GENERAL").description, /market research, SEO, and growth copy/u);
  assert.match(projectTypeOption("CLIENT_PORTAL").description, /without market, SEO, or growth agents/u);
});

test("the workspace shell sends the chosen type, verifies it on read-back, and locks it after creation", async () => {
  const source = await readFile(resolve(process.cwd(), "src/components/workspace-shell.tsx"), "utf8");

  // GENERAL stays the default so nothing changes unless the person chooses otherwise.
  assert.match(source, /useState<ProjectType>\("GENERAL"\)/u);
  assert.match(source, /description: "Created from the Atoms developer workspace",\s*projectType,/u);
  assert.match(source, /verified\.projectType !== projectType/u);
  assert.match(source, /PROJECT_TYPE_OPTIONS\.map/u);
  assert.match(
    source,
    /value=\{projectType\}\s*disabled=\{project !== undefined\}/u,
  );
});

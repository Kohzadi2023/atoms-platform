import assert from "node:assert/strict";
import test from "node:test";

import { ProjectTypeSchema } from "@atoms/contracts";

import {
  PROJECT_TYPE_OPTIONS,
  projectTypeOption,
} from "./project-type-selection";

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

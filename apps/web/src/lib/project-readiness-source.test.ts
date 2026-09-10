import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("project readiness UI cannot invoke run creation", async () => {
  const source = await readFile(
    resolve(process.cwd(), "src/components/project-readiness-gate.tsx"),
    "utf8",
  );

  assert.match(source, /Create project only/u);
  assert.doesNotMatch(source, /\.createRun\s*\(/u);
  assert.doesNotMatch(source, /\/runs(?:[\"'`/]|$)/u);
  assert.doesNotMatch(source, /OpenAI.*E2B.*run/u);
});

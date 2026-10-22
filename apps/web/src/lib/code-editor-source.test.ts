import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { buildContentSecurityPolicy } from "./content-security-policy.js";

const read = (path: string) => readFile(resolve(process.cwd(), path), "utf8");

test("the code editor serves Monaco from the bundle, not a CDN", async () => {
  const editor = await read("src/components/code-editor.tsx");
  const setup = await read("src/components/monaco-setup.ts");

  assert.match(editor, /import\("\.\/monaco-setup"\)/u);
  assert.match(setup, /import \* as monaco from "monaco-editor"/u);
  assert.match(setup, /loader\.config\(\{ monaco \}\)/u);
  assert.doesNotMatch(`${editor}${setup}`, /jsdelivr|unpkg|cdnjs/u);
});

test("Monaco workers cover every language the editor selects and stay same-origin", async () => {
  const setup = await read("src/components/monaco-setup.ts");

  for (const worker of [
    "monaco-editor/editor/editor.worker.js",
    "monaco-editor/language/json/json.worker.js",
    "monaco-editor/language/css/css.worker.js",
    "monaco-editor/language/typescript/ts.worker.js",
  ]) {
    assert.ok(setup.includes(worker), `missing worker ${worker}`);
  }
  assert.doesNotMatch(setup, /https?:\/\//u);
});

test("the CSP stays strict so the bundled editor is the only way it can load", () => {
  const policy = buildContentSecurityPolicy({
    controlApiUrl: "https://api.staging.atoms.dev/v1",
    previewBaseDomain: "preview.staging.atoms.dev",
  });

  assert.match(policy, /script-src 'self' 'unsafe-inline'(;|$)/u);
  assert.match(policy, /worker-src 'self' blob:(;|$)/u);
  assert.doesNotMatch(policy, /jsdelivr/u);
});

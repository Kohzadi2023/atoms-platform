import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseArguments, run } from "./build-base-template.mjs";

function fakeProvider() {
  const built = [];
  return {
    built,
    provider: {
      BASE_TEMPLATE_PNPM_VERSION: "11.7.0",
      describeBaseTemplate: async () => ({ fromTemplate: "node", stepTypes: ["RUN"] }),
      buildBaseTemplateOnE2B: async (options) => {
        built.push(options);
        return { name: options.name, templateId: "tpl_123" };
      },
    },
  };
}

test("the name defaults to atoms-base-validation and must be a valid template name", () => {
  const options = parseArguments([]);
  assert.equal(options.name, "atoms-base-validation");
  assert.equal(options.build, false);
  assert.throws(() => parseArguments(["--name", "bad name!"]), /template name/);
  assert.throws(() => parseArguments(["--wipe"]), /unknown argument/);
});

test("without --build it only prints the plan and builds nothing", async () => {
  const { built, provider } = fakeProvider();
  const output = [];

  const code = await run([], {
    environment: { E2B_API_KEY: "key-present" },
    write: (line) => output.push(line),
    loadSandboxProvider: async () => provider,
  });

  assert.equal(code, 0);
  assert.equal(built.length, 0);
  assert.ok(output.some((line) => line.includes("Dry run")));
});

test("--build refuses without an API key and never prints the key", async () => {
  const { built, provider } = fakeProvider();
  const output = [];

  const refused = await run(["--build"], {
    environment: {},
    write: (line) => output.push(line),
    loadSandboxProvider: async () => provider,
  });
  assert.equal(refused, 2);
  assert.equal(built.length, 0);

  const secret = "e2b_super_secret_value";
  const ok = await run(["--build"], {
    environment: { E2B_API_KEY: secret },
    write: (line) => output.push(line),
    loadSandboxProvider: async () => provider,
  });
  assert.equal(ok, 0);
  assert.equal(built[0].name, "atoms-base-validation");
  assert.equal(output.some((line) => line.includes(secret)), false);
});

test("a usage error exits 2 without loading the provider", async () => {
  let loaded = false;
  const code = await run(["--name", "bad name!"], {
    environment: {},
    write: () => undefined,
    loadSandboxProvider: async () => {
      loaded = true;
      return {};
    },
  });

  assert.equal(code, 2);
  assert.equal(loaded, false);
});

test("the script builds only through the sandbox-provider entry points", async () => {
  const source = await readFile(new URL("./build-base-template.mjs", import.meta.url), "utf8");

  assert.match(source, /buildBaseTemplateOnE2B/u);
  assert.doesNotMatch(source, /console\.log\([^)]*E2B_API_KEY/u);
});

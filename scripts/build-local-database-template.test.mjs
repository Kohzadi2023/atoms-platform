import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseArguments, run } from "./build-local-database-template.mjs";

function fakeProvider() {
  const built = [];
  return {
    built,
    provider: {
      LOCAL_DATABASE_APT_PACKAGE: "postgresql",
      LOCAL_DATABASE_PORT: 5433,
      describeLocalDatabaseTemplate: async (base) => ({ fromTemplate: base, stepTypes: ["RUN"] }),
      buildLocalDatabaseTemplateOnE2B: async (options) => {
        built.push(options);
        return { name: options.name, templateId: "tpl_123" };
      },
    },
  };
}

test("a base template is required, and the new name may not overwrite it", () => {
  assert.throws(() => parseArguments([], {}), /--base/);
  assert.throws(() => parseArguments(["--base", "atoms-base-validation", "--name", "atoms-base-validation"], {}), /differ/);
  assert.throws(() => parseArguments(["--base", "atoms-base-validation", "--name", "bad name!"], {}), /template name/);
  assert.throws(() => parseArguments(["--base", "atoms-base-validation", "--wipe"], {}), /unknown argument/);
});

test("the base defaults to E2B_TEMPLATE and the new name is derived from it", () => {
  const options = parseArguments([], { E2B_TEMPLATE: "atoms-base-validation" });

  assert.equal(options.base, "atoms-base-validation");
  assert.equal(options.name, "atoms-base-validation-db");
  assert.equal(options.build, false);
});

test("without --build it only prints the plan and builds nothing", async () => {
  const { built, provider } = fakeProvider();
  const output = [];

  const code = await run(["--base", "atoms-base-validation"], {
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

  const refused = await run(["--base", "atoms-base-validation", "--build"], {
    environment: {},
    write: (line) => output.push(line),
    loadSandboxProvider: async () => provider,
  });
  assert.equal(refused, 2);
  assert.equal(built.length, 0);

  const secret = "e2b_super_secret_value";
  const ok = await run(["--base", "atoms-base-validation", "--build"], {
    environment: { E2B_API_KEY: secret },
    write: (line) => output.push(line),
    loadSandboxProvider: async () => provider,
  });
  assert.equal(ok, 0);
  assert.equal(built[0].name, "atoms-base-validation-db");
  assert.equal(output.some((line) => line.includes(secret)), false);
});

test("a usage error exits 2 without loading the provider", async () => {
  let loaded = false;
  const code = await run(["--base", "x", "--name", "bad name!"], {
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
  const source = await readFile(new URL("./build-local-database-template.mjs", import.meta.url), "utf8");

  assert.match(source, /buildLocalDatabaseTemplateOnE2B/u);
  assert.doesNotMatch(source, /console\.log\([^)]*E2B_API_KEY/u);
});

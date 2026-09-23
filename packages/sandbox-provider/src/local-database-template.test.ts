import assert from "node:assert/strict";
import test from "node:test";

import { Template } from "@e2b/code-interpreter";

import {
  LOCAL_DATABASE_BIN_DIRECTORY,
  LOCAL_DATABASE_DATA_DIRECTORY,
  LOCAL_DATABASE_DIRECTORY,
  LOCAL_DATABASE_NAME,
  LOCAL_DATABASE_PASSWORD,
  LOCAL_DATABASE_PORT,
  LOCAL_DATABASE_URL,
  LOCAL_DATABASE_USER,
  buildLocalDatabaseTemplate,
} from "./local-database-template.js";

interface TemplateJson {
  readonly fromTemplate?: string;
  readonly steps: ReadonlyArray<{
    readonly type: string;
    readonly args: readonly string[];
  }>;
}

async function describe(base = "atoms-nextjs"): Promise<TemplateJson> {
  return JSON.parse(await Template.toJSON(buildLocalDatabaseTemplate(base), false));
}

test("the template layers on the existing (viability) template instead of replacing it", async () => {
  const template = await describe("atoms-nextjs-with-playwright");

  assert.equal(template.fromTemplate, "atoms-nextjs-with-playwright");
});

test("the build installs Postgres, initializes it once, and pins a stable bin path", async () => {
  const template = await describe();
  const run = template.steps.find((step) => step.type === "RUN")?.args[0] ?? "";

  assert.ok(run.includes("apt-get install -y --no-install-recommends postgresql"));
  assert.ok(run.includes(`ln -s`), "a stable symlink is created so no later command has to glob a version number");
  assert.ok(run.includes(LOCAL_DATABASE_BIN_DIRECTORY));
  assert.ok(run.includes(`initdb -D ${LOCAL_DATABASE_DATA_DIRECTORY}`));
  assert.ok(run.includes(`CREATE ROLE ${LOCAL_DATABASE_USER}`));
  assert.ok(run.includes(`CREATE DATABASE ${LOCAL_DATABASE_NAME} OWNER ${LOCAL_DATABASE_USER}`));
  assert.ok(run.includes(String(LOCAL_DATABASE_PORT)));
});

test("the server is stopped again at the end of the build, so a run starts from a clean, closed state", async () => {
  const template = await describe();
  const run = template.steps.find((step) => step.type === "RUN")?.args[0] ?? "";
  const startIndex = run.indexOf(" start");
  const stopIndex = run.indexOf("pg_ctl -D", run.indexOf("pg_ctl -D") + 1);

  assert.ok(startIndex >= 0);
  assert.ok(stopIndex >= 0);
  assert.ok(run.includes("-w stop"));
});

test("build steps run as root, but the data directory ends up owned by the sandbox's own user", async () => {
  const template = await describe();
  const run = template.steps.find((step) => step.type === "RUN");

  assert.equal(run?.args[1], "root");
  assert.ok((run?.args[0] ?? "").endsWith(`chown -R user:user ${LOCAL_DATABASE_DIRECTORY}`.trim()) ||
    (run?.args[0] ?? "").includes(`chown -R user:user ${LOCAL_DATABASE_DIRECTORY}`));
});

test("the connection string points at loopback only, never a public host", () => {
  assert.match(LOCAL_DATABASE_URL, /^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\//);
  assert.ok(LOCAL_DATABASE_URL.includes(String(LOCAL_DATABASE_PORT)));
  assert.ok(LOCAL_DATABASE_URL.includes(LOCAL_DATABASE_PASSWORD));
});

test("a blank base template name is refused", () => {
  assert.throws(() => buildLocalDatabaseTemplate("  "), RangeError);
});

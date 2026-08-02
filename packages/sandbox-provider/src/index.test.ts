import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandExitError,
  RateLimitError,
  type CommandResult,
} from "@e2b/code-interpreter";

import {
  E2BSandboxAdapter,
  SandboxProviderError,
  type E2BSandboxClient,
  type E2BSandboxFactory,
} from "./index.js";

function sandboxFixture(
  overrides: Partial<E2BSandboxClient> = {},
): E2BSandboxClient {
  return {
    sandboxId: "sbx_test",
    files: {
      write: async () => [],
    } as unknown as E2BSandboxClient["files"],
    commands: {
      run: async (_command: string, options?: { background?: boolean }) =>
        options?.background === true
          ? { pid: 41 }
          : {
              exitCode: 0,
              stdout: "ok\n",
              stderr: "",
            },
    } as unknown as E2BSandboxClient["commands"],
    getHost: (port) => `${String(port)}-sbx_test.e2b.app`,
    kill: async () => true,
    ...overrides,
  };
}

test("create uses secure E2B defaults and returns a provider handle", async () => {
  let createOptions: unknown;
  const sandbox = sandboxFixture();
  const factory: E2BSandboxFactory = {
    create: async (options) => {
      createOptions = options;
      return sandbox;
    },
    connect: async () => sandbox,
  };
  const adapter = new E2BSandboxAdapter({
    factory,
    now: () => new Date("2026-07-31T18:00:00.000Z"),
  });

  const handle = await adapter.create({ template: "atoms-nextjs" });

  assert.deepEqual(handle, {
    id: "sbx_test",
    provider: "e2b",
    createdAt: "2026-07-31T18:00:00.000Z",
  });
  assert.deepEqual(createOptions, {
    lifecycle: { onTimeout: "kill", autoResume: false },
    network: { allowedHosts: [], allowPublicTraffic: false },
    template: "atoms-nextjs",
  });
});

test("writeFiles, exec, exposePort, and terminate share the created sandbox", async () => {
  const writtenFiles: unknown[] = [];
  let killed = false;
  const sandbox = sandboxFixture({
    files: {
      write: async (files: unknown) => {
        writtenFiles.push(files);
        return [];
      },
    } as unknown as E2BSandboxClient["files"],
    kill: async () => {
      killed = true;
      return true;
    },
  });
  const adapter = new E2BSandboxAdapter({
    factory: {
      create: async () => sandbox,
      connect: async () => sandbox,
    },
  });

  await adapter.create({});
  await adapter.writeFiles("sbx_test", [
    { path: "app/page.tsx", content: "export default function Page() {}" },
  ]);
  const result = await adapter.exec("sbx_test", { command: "pnpm build" });
  const process = await adapter.startProcess("sbx_test", {
    command: "pnpm start",
  });
  const preview = await adapter.exposePort("sbx_test", 3_000);
  await adapter.terminate("sbx_test");

  assert.deepEqual(writtenFiles, [
    [{ path: "app/page.tsx", data: "export default function Page() {}" }],
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(process.pid, 41);
  assert.deepEqual(preview, {
    port: 3_000,
    url: "https://3000-sbx_test.e2b.app",
  });
  assert.equal(killed, true);
});

test("exec preserves non-zero command diagnostics", async () => {
  const commandFailure: CommandResult = {
    exitCode: 2,
    error: "command failed",
    stdout: "partial output",
    stderr: "build error",
  };
  const sandbox = sandboxFixture({
    commands: {
      run: async () => {
        throw new CommandExitError(commandFailure);
      },
    } as unknown as E2BSandboxClient["commands"],
  });
  const adapter = new E2BSandboxAdapter({
    factory: {
      create: async () => sandbox,
      connect: async () => sandbox,
    },
  });
  await adapter.create({});

  const result = await adapter.exec("sbx_test", { command: "pnpm build" });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "build error");
  assert.equal(result.error, "command failed");
});

test("provider failures are normalized and unsafe file paths are rejected", async () => {
  const adapter = new E2BSandboxAdapter({
    factory: {
      create: async () => {
        throw new RateLimitError("quota exceeded");
      },
      connect: async () => sandboxFixture(),
    },
  });

  await assert.rejects(
    adapter.create({}),
    (error: unknown) =>
      error instanceof SandboxProviderError &&
      error.code === "RATE_LIMITED" &&
      error.retryable,
  );

  const connectedAdapter = new E2BSandboxAdapter({
    factory: {
      create: async () => sandboxFixture(),
      connect: async () => sandboxFixture(),
    },
  });
  await assert.rejects(
    connectedAdapter.writeFiles("sbx_test", [
      { path: "../secrets.env", content: "secret" },
    ]),
    (error: unknown) =>
      error instanceof SandboxProviderError && error.code === "INVALID_INPUT",
  );
});

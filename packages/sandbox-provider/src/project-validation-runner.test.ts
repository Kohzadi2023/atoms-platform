import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PLAYWRIGHT_ENTRY,
  PREVIEW_VIABILITY_SCRIPT,
  PREVIEW_VIABILITY_SCRIPT_PATH,
  ProjectValidationRunner,
  SandboxValidationError,
  type BackgroundProcess,
  type ExecCommand,
  type ExecResult,
  type PreviewUrl,
  type SandboxFileInput,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
  type ValidationStepName,
} from "./index.js";

const handle: SandboxHandle = {
  id: "sbx_validation",
  provider: "e2b",
  createdAt: "2026-08-01T12:00:00.000Z",
};

class FakeSandboxProvider implements SandboxProvider {
  readonly calls: string[] = [];
  readonly written: SandboxFileInput[] = [];
  createSpec: SandboxSpec | undefined;
  failCommand: string | undefined;
  terminated = false;

  async create(input: SandboxSpec): Promise<SandboxHandle> {
    this.calls.push("create");
    this.createSpec = input;
    return handle;
  }

  async writeFiles(
    _id: string,
    files: readonly SandboxFileInput[],
  ): Promise<void> {
    this.calls.push("writeFiles");
    this.written.push(...files);
  }

  async exec(_id: string, command: ExecCommand): Promise<ExecResult> {
    this.calls.push(command.command);
    const failed = command.command === this.failCommand;
    return {
      exitCode: failed ? 2 : 0,
      stdout: failed ? "" : "ok",
      stderr: failed ? "deterministic failure" : "",
      durationMs: 10,
    };
  }

  async startProcess(
    _id: string,
    command: ExecCommand,
  ): Promise<BackgroundProcess> {
    this.calls.push(command.command);
    return { pid: 73 };
  }

  async exposePort(_id: string, port: number): Promise<PreviewUrl> {
    this.calls.push(`expose:${String(port)}`);
    return {
      port,
      url: "https://3000-sbx_validation.e2b.app",
      requestHeaders: { "E2B-Traffic-Access-Token": "provider-secret" },
    };
  }

  async terminate(): Promise<void> {
    this.calls.push("terminate");
    this.terminated = true;
  }
}

const files = [
  { path: "package.json", content: '{"scripts":{}}' },
  { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'" },
  { path: "app/page.tsx", content: "export default function Page() {}" },
];

test("runner restores a locked revision and executes the fixed validation pipeline", async () => {
  const provider = new FakeSandboxProvider();
  const observedSteps: ValidationStepName[] = [];
  const runner = new ProjectValidationRunner({
    provider,
    template: "atoms-nextjs",
    now: () => new Date("2026-08-01T12:00:00.000Z"),
  });

  const result = await runner.validate({
    files,
    metadata: { runId: "run-1", workspaceId: "workspace-1" },
    hooks: {
      onStep: async (_sandbox, step) => {
        observedSteps.push(step.name);
      },
    },
  });

  assert.deepEqual(observedSteps, [
    "install",
    "prisma-validate",
    "lint",
    "typecheck",
    "test",
    "build",
    "preview-start",
    "preview-health",
  ]);
  assert.deepEqual(
    provider.calls.slice(2, 8),
    [
      "pnpm install --frozen-lockfile",
      "pnpm exec prisma validate",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
    ],
  );
  assert.equal(provider.written[2]?.path, "/home/user/project/app/page.tsx");
  assert.deepEqual(provider.createSpec?.network, {
    allowedHosts: ["registry.npmjs.org", "binaries.prisma.sh"],
    allowPublicTraffic: false,
  });
  assert.deepEqual(provider.createSpec?.lifecycle, {
    onTimeout: "kill",
    autoResume: false,
  });
  assert.equal(result.previewProcessId, 73);
  assert.equal(result.preview.requestHeaders?.["E2B-Traffic-Access-Token"], "provider-secret");
  assert.equal(provider.terminated, false);
});

test("runner records a deterministic command failure and always terminates the sandbox", async () => {
  const provider = new FakeSandboxProvider();
  provider.failCommand = "pnpm typecheck";
  const observed: ValidationStepName[] = [];
  const runner = new ProjectValidationRunner({ provider });

  await assert.rejects(
    runner.validate({
      files,
      metadata: {},
      hooks: {
        onStep: async (_sandbox, step) => {
          observed.push(step.name);
        },
      },
    }),
    (error: unknown) =>
      error instanceof SandboxValidationError &&
      error.step === "typecheck" &&
      !error.retryable,
  );
  assert.deepEqual(observed, [
    "install",
    "prisma-validate",
    "lint",
    "typecheck",
  ]);
  assert.equal(provider.terminated, true);
  assert.equal(provider.calls.includes("pnpm test"), false);
});

test("runner rejects snapshots without pnpm-lock.yaml before provisioning", async () => {
  const provider = new FakeSandboxProvider();
  const runner = new ProjectValidationRunner({ provider });

  await assert.rejects(
    runner.validate({
      files: [{ path: "package.json", content: "{}" }],
      metadata: {},
    }),
  );
  assert.deepEqual(provider.calls, []);
});

test("generated files and metadata cannot alter the sandbox network policy", async () => {
  const provider = new FakeSandboxProvider();
  const runner = new ProjectValidationRunner({
    provider,
    allowedHosts: ["registry.npmjs.org"],
  });

  await runner.validate({
    files: [
      ...files,
      {
        path: "sandbox.config.json",
        content: JSON.stringify({ allowedHosts: ["*"], allowPublicTraffic: true }),
      },
      { path: ".env", content: "E2B_ALLOWED_HOSTS=*\nallowPublicTraffic=true" },
    ],
    metadata: {
      runId: "run-1",
      allowedHosts: "*",
      allowPublicTraffic: "true",
    },
  });

  assert.deepEqual(provider.createSpec?.network, {
    allowedHosts: ["registry.npmjs.org"],
    allowPublicTraffic: false,
  });
  assert.equal(provider.createSpec?.allowInternetAccess, undefined);
});

test("the runner has no default that reaches beyond the package registries", async () => {
  const provider = new FakeSandboxProvider();
  await new ProjectValidationRunner({ provider }).validate({
    files,
    metadata: { runId: "run-1" },
  });

  assert.deepEqual(provider.createSpec?.network?.allowedHosts, [
    "registry.npmjs.org",
    "binaries.prisma.sh",
  ]);
});

test("without browserViability the health step is the plain HTTP check and no script is written", async () => {
  const provider = new FakeSandboxProvider();
  await new ProjectValidationRunner({ provider }).validate({
    files,
    metadata: { runId: "run-1" },
  });

  assert.equal(
    provider.written.some((file) => file.path === PREVIEW_VIABILITY_SCRIPT_PATH),
    false,
  );
  assert.equal(provider.calls.some((call) => call.startsWith("node /tmp/atoms-viability")), false);
});

test("with browserViability the health step runs the viability script with the port and Playwright entry", async () => {
  const provider = new FakeSandboxProvider();
  const execs: ExecCommand[] = [];
  const original = provider.exec.bind(provider);
  provider.exec = async (id, command) => {
    execs.push(command);
    return original(id, command);
  };
  const steps: string[] = [];

  await new ProjectValidationRunner({
    provider,
    previewPort: 3100,
    browserViability: { playwrightEntry: "/opt/pw/index.mjs" },
  }).validate({
    files,
    metadata: { runId: "run-1" },
    hooks: {
      onStep: async (_sandbox, step) => {
        steps.push(step.name);
      },
    },
  });

  const script = provider.written.find((file) => file.path === PREVIEW_VIABILITY_SCRIPT_PATH);
  assert.equal(script?.content, PREVIEW_VIABILITY_SCRIPT);
  const health = execs.find((command) => command.command === `node ${PREVIEW_VIABILITY_SCRIPT_PATH}`);
  assert.deepEqual(health?.envs, {
    VIABILITY_PORT: "3100",
    VIABILITY_PLAYWRIGHT_ENTRY: "/opt/pw/index.mjs",
  });
  // Same step name, so evidence mapping and persistence are unchanged.
  assert.equal(steps.at(-1), "preview-health");
});

test("a failing viability script fails the preview-health step and terminates the sandbox", async () => {
  const provider = new FakeSandboxProvider();
  provider.failCommand = `node ${PREVIEW_VIABILITY_SCRIPT_PATH}`;

  await assert.rejects(
    new ProjectValidationRunner({
      provider,
      browserViability: {},
    }).validate({ files, metadata: {} }),
    (error: unknown) =>
      error instanceof SandboxValidationError &&
      error.step === "preview-health" &&
      !error.retryable,
  );
  assert.equal(provider.terminated, true);
  assert.equal(provider.calls.some((call) => call.startsWith("expose:")), false);
});

test("browserViability defaults to the template's Playwright location", async () => {
  const provider = new FakeSandboxProvider();
  const execs: ExecCommand[] = [];
  const original = provider.exec.bind(provider);
  provider.exec = async (id, command) => {
    execs.push(command);
    return original(id, command);
  };

  await new ProjectValidationRunner({ provider, browserViability: {} }).validate({
    files,
    metadata: {},
  });

  assert.equal(
    execs.find((command) => command.command.startsWith("node /tmp"))?.envs
      ?.VIABILITY_PLAYWRIGHT_ENTRY,
    DEFAULT_PLAYWRIGHT_ENTRY,
  );
});

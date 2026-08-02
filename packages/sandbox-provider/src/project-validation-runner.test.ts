import assert from "node:assert/strict";
import test from "node:test";

import {
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

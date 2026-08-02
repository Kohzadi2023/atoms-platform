import assert from "node:assert/strict";
import test from "node:test";

import type { AgentProjectFile } from "@atoms/agents";
import type { JsonValue } from "@atoms/contracts";
import {
  PreviewTicketSigner,
  type PreviewSessionStore,
  type PreviewTarget,
} from "@atoms/preview";
import type {
  ProjectValidationInput,
  ProjectValidationResult,
  ValidationStepReport,
} from "@atoms/sandbox-provider";

import type { RunExecutionRecord } from "./domain.js";
import type {
  CreateSandboxSessionInput,
  Phase2ValidationRepository,
  RecordPreviewReadyInput,
  RecordSandboxCommandInput,
  SandboxSessionMutationResult,
} from "./validation.js";
import { Phase2RunValidator } from "./validation.js";

const RUN: RunExecutionRecord = {
  id: "00000000-0000-4000-8000-000000000031",
  workspaceId: "00000000-0000-4000-8000-000000000032",
  projectId: "00000000-0000-4000-8000-000000000033",
  status: "RUNNING",
  prompt: "Build a portal",
  controlVersion: 1,
};
const SANDBOX_SESSION_ID = "00000000-0000-4000-8000-000000000034";
const NOW = new Date("2026-08-01T12:00:00.000Z");

class MemoryValidationRepository implements Phase2ValidationRepository {
  readonly files: AgentProjectFile[] = [
    { path: "package.json", content: "{}", version: 1 },
    { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'", version: 1 },
  ];
  readonly commands: RecordSandboxCommandInput[] = [];
  readonly failures: JsonValue[] = [];
  stoppedCount = 0;
  preview: RecordPreviewReadyInput | undefined;
  previewIsActive = true;

  async listProjectFiles(): Promise<readonly AgentProjectFile[]> {
    return this.files;
  }

  async createSandboxSession(
    _input: CreateSandboxSessionInput,
  ): Promise<SandboxSessionMutationResult> {
    return { kind: "ok", sandboxSessionId: SANDBOX_SESSION_ID };
  }

  async markSandboxFilesRestored(): Promise<boolean> {
    return true;
  }

  async recordSandboxCommand(input: RecordSandboxCommandInput): Promise<boolean> {
    this.commands.push(input);
    return true;
  }

  async recordPreviewReady(input: RecordPreviewReadyInput): Promise<boolean> {
    this.preview = input;
    return this.previewIsActive;
  }

  async markSandboxFailed(
    _sandboxSessionId: string,
    error: JsonValue,
  ): Promise<void> {
    this.failures.push(error);
  }

  async markPreviewStopped(): Promise<void> {
    this.stoppedCount += 1;
  }
}

class MemoryPreviewStore implements PreviewSessionStore {
  target: PreviewTarget | null = null;
  deleteCount = 0;
  async put(target: PreviewTarget): Promise<void> {
    this.target = target;
  }
  async get(): Promise<PreviewTarget | null> {
    return this.target;
  }
  async delete(): Promise<void> {
    this.deleteCount += 1;
    this.target = null;
  }
  async close(): Promise<void> {}
}

class SuccessfulRunner {
  terminated = false;

  async validate(input: ProjectValidationInput): Promise<ProjectValidationResult> {
    const sandbox = {
      id: "sbx_phase_2",
      provider: "e2b" as const,
      createdAt: NOW.toISOString(),
    };
    const step: ValidationStepReport = {
      ordinal: 1,
      name: "install",
      command: "pnpm install --frozen-lockfile",
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      result: {
        exitCode: 0,
        stdout: "installed",
        stderr: "",
        durationMs: 25,
      },
    };
    await input.hooks?.onSandboxCreated?.(
      sandbox,
      "2026-08-01T12:15:00.000Z",
    );
    await input.hooks?.onFilesRestored?.(sandbox);
    await input.hooks?.onStep?.(sandbox, step);
    return {
      sandbox,
      expiresAt: "2026-08-01T12:15:00.000Z",
      previewProcessId: 91,
      preview: {
        port: 3_000,
        url: "https://3000-sbx_phase_2.e2b.app",
        requestHeaders: {
          "E2B-Traffic-Access-Token": "provider-secret",
        },
      },
      steps: [step],
    };
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }
}

function signer(): PreviewTicketSigner {
  return new PreviewTicketSigner({
    secret: "phase-2-worker-preview-secret-at-least-32-bytes",
    baseDomain: "preview.example.test",
    now: () => NOW,
  });
}

test("Phase 2 validator persists command evidence and exposes only the signed gateway URL", async () => {
  const repository = new MemoryValidationRepository();
  const store = new MemoryPreviewStore();
  const runner = new SuccessfulRunner();
  const validator = new Phase2RunValidator({
    repository,
    runner,
    previewStore: store,
    previewSigner: signer(),
    now: () => NOW,
  });

  await validator.validate({ run: RUN, attempt: 1 });

  assert.equal(repository.commands[0]?.step.name, "install");
  assert.equal(repository.preview?.sandboxSessionId, SANDBOX_SESSION_ID);
  assert.match(repository.preview?.gatewayUrl ?? "", /^https:\/\//);
  assert.equal(repository.preview?.gatewayUrl.includes("provider-secret"), false);
  assert.equal(
    store.target?.requestHeaders["E2B-Traffic-Access-Token"],
    "provider-secret",
  );
  assert.equal(runner.terminated, false);
  assert.deepEqual(repository.failures, []);
});

test("Phase 2 validator revokes the Redis target and terminates E2B if the run stops before publication", async () => {
  const repository = new MemoryValidationRepository();
  repository.previewIsActive = false;
  const store = new MemoryPreviewStore();
  const runner = new SuccessfulRunner();
  const validator = new Phase2RunValidator({
    repository,
    runner,
    previewStore: store,
    previewSigner: signer(),
    now: () => NOW,
  });

  await assert.rejects(validator.validate({ run: RUN, attempt: 1 }));

  assert.equal(store.target, null);
  assert.equal(store.deleteCount, 1);
  assert.equal(runner.terminated, true);
  assert.equal(repository.failures.length, 1);
});

test("published preview lease is revocable when run completion loses its control-version race", async () => {
  const repository = new MemoryValidationRepository();
  const store = new MemoryPreviewStore();
  const runner = new SuccessfulRunner();
  const validator = new Phase2RunValidator({
    repository,
    runner,
    previewStore: store,
    previewSigner: signer(),
    now: () => NOW,
  });
  const lease = await validator.validate({ run: RUN, attempt: 1 });

  await lease.revoke();
  await lease.revoke();

  assert.equal(store.target, null);
  assert.equal(store.deleteCount, 1);
  assert.equal(runner.terminated, true);
  assert.equal(repository.stoppedCount, 1);
});

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentProjectFile } from "@atoms/agents";
import type { PreviewReopenJob } from "@atoms/contracts";
import {
  PreviewTicketSigner,
  type PreviewSessionStore,
  type PreviewTarget,
} from "@atoms/preview";
import type {
  ProjectValidationInput,
  ProjectValidationResult,
} from "@atoms/sandbox-provider";

import {
  PreviewReopenProcessor,
  type CreatePreviewReopenSessionInput,
  type PreviewReopenRepository,
  type RecordPreviewReopenFailedInput,
  type RecordPreviewReopenedInput,
} from "./preview-reopen.js";

const JOB: PreviewReopenJob = {
  projectId: "00000000-0000-4000-8000-000000000041",
  workspaceId: "00000000-0000-4000-8000-000000000042",
  runId: "00000000-0000-4000-8000-000000000043",
};
const SESSION_ID = "00000000-0000-4000-8000-000000000044";
const NOW = new Date("2026-08-01T12:00:00.000Z");
const EXPIRES = "2026-08-01T12:30:00.000Z";

class MemoryRepository implements PreviewReopenRepository {
  files: AgentProjectFile[] = [{ path: "package.json", content: "{}", version: 1 }];
  runIsCompleted = true;
  created: CreatePreviewReopenSessionInput[] = [];
  reopened: RecordPreviewReopenedInput[] = [];
  failed: RecordPreviewReopenFailedInput[] = [];

  async listProjectFiles(): Promise<readonly AgentProjectFile[]> {
    return this.files;
  }
  async createPreviewReopenSession(
    input: CreatePreviewReopenSessionInput,
  ): Promise<string | null> {
    this.created.push(input);
    return this.runIsCompleted ? SESSION_ID : null;
  }
  async recordPreviewReopened(input: RecordPreviewReopenedInput): Promise<void> {
    this.reopened.push(input);
  }
  async recordPreviewReopenFailed(input: RecordPreviewReopenFailedInput): Promise<void> {
    this.failed.push(input);
  }
}

class MemoryStore implements PreviewSessionStore {
  target: PreviewTarget | null = null;
  deleted = 0;
  async put(target: PreviewTarget): Promise<void> {
    this.target = target;
  }
  async get(): Promise<PreviewTarget | null> {
    return this.target;
  }
  async delete(): Promise<void> {
    this.deleted += 1;
    this.target = null;
  }
  async close(): Promise<void> {}
}

class FakeRunner {
  terminated: string[] = [];
  received: ProjectValidationInput | undefined;
  environment: Readonly<Record<string, string>> | undefined;
  failWith: Error | undefined;

  async validate(input: ProjectValidationInput): Promise<ProjectValidationResult> {
    this.received = input;
    const sandbox = { id: "sbx_reopen", provider: "e2b" as const, createdAt: NOW.toISOString() };
    await input.hooks?.onSandboxCreated?.(sandbox, EXPIRES);
    if (this.failWith !== undefined) throw this.failWith;
    this.environment = await input.hooks?.previewEnvironment?.(sandbox, EXPIRES);
    return {
      sandbox,
      expiresAt: EXPIRES,
      previewProcessId: 91,
      preview: {
        port: 3_000,
        url: "https://3000-sbx_reopen.e2b.app",
        requestHeaders: { "E2B-Traffic-Access-Token": "provider-secret" },
      },
      steps: [],
    };
  }
  async terminate(id: string): Promise<void> {
    this.terminated.push(id);
  }
}

function build(): {
  repository: MemoryRepository;
  store: MemoryStore;
  runner: FakeRunner;
  processor: PreviewReopenProcessor;
} {
  const repository = new MemoryRepository();
  const store = new MemoryStore();
  const runner = new FakeRunner();
  const processor = new PreviewReopenProcessor({
    repository,
    runner,
    previewStore: store,
    previewSigner: new PreviewTicketSigner({
      secret: "preview-reopen-worker-secret-at-least-32-bytes",
      baseDomain: "preview.example.test",
      now: () => NOW,
    }),
    now: () => NOW,
  });
  return { repository, store, runner, processor };
}

test("reopening restores the saved files and publishes a new signed preview for the run", async () => {
  const { repository, store, runner, processor } = build();

  await processor.process(JOB);

  assert.equal(runner.received?.previewOnly, true);
  assert.deepEqual(runner.received?.files, [{ path: "package.json", content: "{}" }]);
  assert.equal(repository.created[0]?.runId, JOB.runId);
  assert.equal(repository.reopened.length, 1);
  assert.equal(repository.reopened[0]?.sandboxSessionId, SESSION_ID);
  assert.equal(repository.reopened[0]?.runId, JOB.runId);
  assert.equal(repository.reopened[0]?.processId, 91);
  assert.match(repository.reopened[0]?.gatewayUrl ?? "", /^https:\/\//);
  assert.equal(repository.reopened[0]?.gatewayUrl.includes("provider-secret"), false);
  assert.equal(store.target?.requestHeaders["E2B-Traffic-Access-Token"], "provider-secret");
  assert.deepEqual(repository.failed, []);
});

test("the app is told its own public address and a session secret before it starts", async () => {
  const { runner, processor } = build();

  await processor.process(JOB);

  assert.match(runner.environment?.NEXTAUTH_URL ?? "", /^https:\/\//);
  assert.ok((runner.environment?.NEXTAUTH_SECRET ?? "").length >= 32);
  assert.equal(runner.environment?.AUTH_SECRET, runner.environment?.NEXTAUTH_SECRET);
});

test("a failed re-open is recorded for the UI, cleans up, and is not retried", async () => {
  const { repository, store, runner, processor } = build();
  runner.failWith = new Error("build exited with code 1");

  await processor.process(JOB);

  assert.equal(repository.reopened.length, 0);
  assert.equal(repository.failed.length, 1);
  assert.equal(repository.failed[0]?.runId, JOB.runId);
  assert.equal(repository.failed[0]?.sandboxSessionId, SESSION_ID);
  assert.deepEqual(runner.terminated, ["sbx_reopen"]);
  assert.equal(store.deleted, 1);
});

test("a run that is not a completed run of the project is skipped quietly and its sandbox is terminated", async () => {
  const { repository, runner, processor } = build();
  repository.runIsCompleted = false;

  await processor.process(JOB);

  assert.equal(repository.reopened.length, 0);
  assert.deepEqual(repository.failed, []);
  assert.deepEqual(runner.terminated, ["sbx_reopen"]);
});

test("a project with no saved files is reported as a failure without creating a sandbox", async () => {
  const { repository, runner, processor } = build();
  repository.files = [];

  await processor.process(JOB);

  assert.equal(runner.received, undefined);
  assert.equal(repository.created.length, 0);
  assert.equal(repository.failed.length, 1);
  assert.equal(repository.failed[0]?.sandboxSessionId, undefined);
});

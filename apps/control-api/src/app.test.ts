import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentRunStatus,
  CreateProjectInput,
  FileContentInput,
  JsonValue,
} from "@atoms/contracts";
import { normalizeArtifactCreatedEventPayload } from "@atoms/contracts";

import { buildControlApi } from "./app.js";
import type {
  ProjectFileRecord,
  ProjectRecord,
  RunArtifactRecord,
  RunEventRecord,
  RunJob,
  RunRecord,
  RunStatusPatch,
} from "./domain.js";
import {
  RepositoryAttachmentError,
  RepositoryConflictError,
} from "./errors.js";
import type {
  CreateRunWithIdempotencyResult,
  ControlRepository,
  PutProjectFileResult,
  WorkspaceMembershipRecord,
} from "./repository.js";
import type { RunQueue } from "./run-queue.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const FIXED_NOW = new Date("2026-07-31T20:00:00.000Z");

class MemoryRepository implements ControlRepository {
  readonly projects = new Map<string, ProjectRecord>();
  readonly runs = new Map<string, RunRecord>();
  readonly events: RunEventRecord[] = [];
  readonly artifactContentsByTaskId = new Map<string, JsonValue>();
  readonly files: ProjectFileRecord[] = [];
  lastRunAttachmentIds: readonly string[] = [];
  rejectRunAttachments = false;
  readonly runsByIdempotencyKey = new Map<string, RunRecord>();
  readonly runPayloadByIdempotencyKey = new Map<
    string,
    { readonly prompt: string; readonly attachmentIds: readonly string[] }
  >();
  #projectCounter = 0;
  #runCounter = 0;
  #fileCounter = 0;

  async listWorkspaceMemberships(
    userId: string,
  ): Promise<readonly WorkspaceMembershipRecord[]> {
    if (userId !== "user-test") return [];
    return [
      {
        workspace: {
          id: WORKSPACE_ID,
          name: "Workspace",
          slug: "workspace",
        },
        role: "OWNER",
      },
    ];
  }

  async getWorkspaceMembership(
    userId: string,
    workspaceId: string,
  ): Promise<WorkspaceMembershipRecord | null> {
    const memberships = await this.listWorkspaceMemberships(userId);
    return memberships.find((membership) => membership.workspace.id === workspaceId) ?? null;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const duplicate = [...this.projects.values()].some(
      (project) =>
        project.workspaceId === input.workspaceId && project.slug === input.slug,
    );
    if (duplicate) {
      throw new RepositoryConflictError("Duplicate project slug", "test_unique");
    }
    this.#projectCounter += 1;
    const project: ProjectRecord = {
      id: this.#projectCounter === 1 ? PROJECT_ID : uuid(this.#projectCounter + 10),
      workspaceId: input.workspaceId,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      archivedAt: null,
    };
    this.projects.set(project.id, project);
    return project;
  }

  async getProject(_userId: string, projectId: string): Promise<ProjectRecord | null> {
    const project = this.projects.get(projectId);
    return project === undefined || project.archivedAt !== null ? null : project;
  }

  async createRun(
    userId: string,
    projectId: string,
    prompt: string,
    attachmentIds: readonly string[] = [],
  ): Promise<RunRecord | null> {
    const result = await this.createRunWithIdempotency(
      userId,
      projectId,
      prompt,
      `legacy-${uuid(this.#runCounter + 5000)}`,
      attachmentIds,
    );
    if (result.kind === "project_not_found") return null;
    return result.run;
  }

  async createRunWithIdempotency(
    _userId: string,
    projectId: string,
    prompt: string,
    idempotencyKey: string,
    attachmentIds: readonly string[] = [],
  ): Promise<CreateRunWithIdempotencyResult> {
    this.lastRunAttachmentIds = attachmentIds;
    if (this.rejectRunAttachments) {
      throw new RepositoryAttachmentError(attachmentIds);
    }
    const existing = this.runsByIdempotencyKey.get(idempotencyKey);
    const existingPayload = this.runPayloadByIdempotencyKey.get(idempotencyKey);
    if (existing !== undefined) {
      if (
        existing.projectId !== projectId ||
        existingPayload?.prompt !== prompt ||
        JSON.stringify(existingPayload.attachmentIds) !==
          JSON.stringify(attachmentIds)
      ) {
        return { kind: "idempotency_conflict", run: existing };
      }
      return { kind: "ok", run: existing, replayed: true };
    }
    const project = this.projects.get(projectId);
    if (project === undefined || project.archivedAt !== null) {
      return { kind: "project_not_found" };
    }
    this.#runCounter += 1;
    const run: RunRecord = {
      id: this.#runCounter === 1 ? RUN_ID : uuid(this.#runCounter + 20),
      workspaceId: project.workspaceId,
      projectId,
      status: "PENDING",
      prompt,
      eventSequence: 0,
      controlVersion: 0,
      error: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      startedAt: null,
      pausedAt: null,
      completedAt: null,
      cancelledAt: null,
    };
    this.runs.set(run.id, run);
    this.runsByIdempotencyKey.set(idempotencyKey, run);
    this.runPayloadByIdempotencyKey.set(idempotencyKey, {
      prompt,
      attachmentIds: [...attachmentIds],
    });
    return { kind: "ok", run, replayed: false };
  }

  async getRun(_userId: string, runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async transitionRun(
    _userId: string,
    runId: string,
    expectedStatus: AgentRunStatus,
    expectedControlVersion: number,
    patch: RunStatusPatch,
  ): Promise<RunRecord | null> {
    const current = this.runs.get(runId);
    if (
      current === undefined ||
      current.status !== expectedStatus ||
      current.controlVersion !== expectedControlVersion
    ) {
      return null;
    }
    const updated: RunRecord = {
      ...current,
      status: patch.status,
      controlVersion: current.controlVersion + 1,
      updatedAt: FIXED_NOW,
      ...(patch.pausedAt === undefined ? {} : { pausedAt: patch.pausedAt }),
      ...(patch.completedAt === undefined
        ? {}
        : { completedAt: patch.completedAt }),
      ...(patch.cancelledAt === undefined
        ? {}
        : { cancelledAt: patch.cancelledAt }),
      ...(patch.startedAt === undefined ? {} : { startedAt: patch.startedAt }),
      ...(patch.error === undefined ? {} : { error: patch.error }),
    };
    this.runs.set(runId, updated);
    return updated;
  }

  async markRunFailed(
    runId: string,
    expectedControlVersion: number,
    error: JsonValue,
  ): Promise<void> {
    const current = this.runs.get(runId);
    if (
      current !== undefined &&
      current.status === "PENDING" &&
      current.controlVersion === expectedControlVersion
    ) {
      this.runs.set(runId, {
        ...current,
        status: "FAILED",
        completedAt: FIXED_NOW,
        error,
      });
    }
  }

  async listRunEventsAfter(
    _userId: string,
    runId: string,
    sequence: number,
    limit: number,
  ): Promise<readonly RunEventRecord[]> {
    return this.events
      .filter((event) => event.runId === runId && event.sequence > sequence)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit);
  }

  async listRunArtifacts(
    _userId: string,
    runId: string,
  ): Promise<readonly RunArtifactRecord[]> {
    return this.events
      .filter(
        (event) =>
          event.runId === runId && event.eventType === "artifact.created",
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map((event) => ({
        sequence: event.sequence,
        createdAt: event.createdAt,
        payload: normalizeArtifactCreatedEventPayload(event.payload),
        content:
          this.artifactContentsByTaskId.get(
            normalizeArtifactCreatedEventPayload(event.payload).taskId,
          ) ?? null,
      }));
  }

  async listProjectFiles(
    _userId: string,
    projectId: string,
  ): Promise<readonly ProjectFileRecord[] | null> {
    if (!this.projects.has(projectId)) return null;
    const latestByPath = new Map<string, ProjectFileRecord>();
    for (const file of this.files) {
      if (file.projectId !== projectId) continue;
      const current = latestByPath.get(file.filePath);
      if (current === undefined || current.version < file.version) {
        latestByPath.set(file.filePath, file);
      }
    }
    return [...latestByPath.values()].sort((left, right) =>
      left.filePath.localeCompare(right.filePath),
    );
  }

  async getProjectFile(
    _userId: string,
    projectId: string,
    filePath: string,
    version?: number,
  ): Promise<ProjectFileRecord | null> {
    return (
      this.files
        .filter(
          (file) =>
            file.projectId === projectId &&
            file.filePath === filePath &&
            (version === undefined || file.version === version),
        )
        .sort((left, right) => right.version - left.version)[0] ?? null
    );
  }

  async putProjectFile(
    _userId: string,
    projectId: string,
    input: FileContentInput,
  ): Promise<PutProjectFileResult> {
    if (!this.projects.has(projectId)) return { kind: "project_not_found" };
    const latest = await this.getProjectFile("user-test", projectId, input.filePath);
    const actualVersion = latest?.version ?? null;
    if (
      (input.expectedVersion === 0 && latest !== null) ||
      (input.expectedVersion !== 0 && input.expectedVersion !== actualVersion)
    ) {
      return { kind: "version_conflict", actualVersion };
    }
    this.#fileCounter += 1;
    const file: ProjectFileRecord = {
      id: uuid(this.#fileCounter + 100),
      projectId,
      filePath: input.filePath,
      content: input.content,
      version: (actualVersion ?? 0) + 1,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    this.files.push(file);
    return { kind: "ok", file };
  }

  async close(): Promise<void> {}

  setRunStatus(runId: string, status: AgentRunStatus): void {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error("Run fixture not found");
    this.runs.set(runId, { ...run, status });
  }
}

class MemoryRunQueue implements RunQueue {
  readonly jobs: RunJob[] = [];
  fail = false;

  async enqueue(job: RunJob): Promise<void> {
    if (this.fail) throw new Error("Redis unavailable");
    this.jobs.push(job);
  }

  async close(): Promise<void> {}
}

async function fixture(corsOrigins: readonly string[] = []): Promise<{
  readonly repository: MemoryRepository;
  readonly queue: MemoryRunQueue;
  readonly app: Awaited<ReturnType<typeof buildControlApi>>;
}> {
  const repository = new MemoryRepository();
  const queue = new MemoryRunQueue();
  const app = await buildControlApi({
    repository,
    runQueue: queue,
    authRequired: false,
    now: () => FIXED_NOW,
    ssePollIntervalMs: 1,
    sseHeartbeatMs: 10,
    sseMaxConnectionMs: 100,
    corsOrigins,
  });
  return { repository, queue, app };
}

async function createProjectAndRun(
  repository: MemoryRepository,
): Promise<RunRecord> {
  await repository.createProject({
    workspaceId: WORKSPACE_ID,
    name: "Atoms",
    slug: "atoms",
  });
  const run = await repository.createRun("user-test", PROJECT_ID, "Build a CRM");
  if (run === null) throw new Error("Run fixture was not created");
  return run;
}

test("POST /v1/projects validates and creates a normalized project", async () => {
  const { app } = await fixture();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        workspaceId: WORKSPACE_ID,
        name: "  Customer Portal  ",
        slug: "customer-portal",
      },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().name, "Customer Portal");

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        workspaceId: WORKSPACE_ID,
        name: "Portal",
        slug: "Customer_Portal",
        unexpected: true,
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "VALIDATION_ERROR");

    const restored = await app.inject({
      method: "GET",
      url: `/v1/projects/${PROJECT_ID}`,
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().slug, "customer-portal");
  } finally {
    await app.close();
  }
});

test("POST /v1/projects/:id/runs persists and enqueues an idempotent run command", async () => {
  const { app, queue } = await fixture();
  try {
    await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        workspaceId: WORKSPACE_ID,
        name: "Atoms",
        slug: "atoms",
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/runs`,
      headers: { "idempotency-key": "create-run-atoms-v1" },
      payload: { prompt: "  Build a CRM  " },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().prompt, "Build a CRM");
    assert.deepEqual(queue.jobs, [
      { runId: RUN_ID, command: "start", controlVersion: 0 },
    ]);

    const replay = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/runs`,
      headers: { "idempotency-key": "create-run-atoms-v1" },
      payload: { prompt: "Build a CRM" },
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().id, RUN_ID);
    assert.equal(queue.jobs.length, 1);
  } finally {
    await app.close();
  }
});

test("run creation rejects idempotency-key payload mismatch", async () => {
  const { app } = await fixture();
  try {
    await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        workspaceId: WORKSPACE_ID,
        name: "Atoms",
        slug: "atoms",
      },
    });
    const first = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/runs`,
      headers: { "idempotency-key": "create-run-atoms-v2" },
      payload: { prompt: "Build a CRM" },
    });
    assert.equal(first.statusCode, 201);

    const conflict = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/runs`,
      headers: { "idempotency-key": "create-run-atoms-v2" },
      payload: { prompt: "Build a payments service" },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "IDEMPOTENCY_KEY_CONFLICT");
  } finally {
    await app.close();
  }
});

test("run creation snapshots only repository-approved clean attachments", async () => {
  const { app, repository, queue } = await fixture();
  const attachmentId = "00000000-0000-4000-8000-000000000094";
  try {
    await repository.createProject({
      workspaceId: WORKSPACE_ID,
      name: "Atoms",
      slug: "atoms",
    });
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/runs`,
      headers: { "idempotency-key": "attachments-run-v1" },
      payload: { prompt: "Build a CRM", attachmentIds: [attachmentId] },
    });
    assert.equal(accepted.statusCode, 201);
    assert.deepEqual(repository.lastRunAttachmentIds, [attachmentId]);
    assert.equal(queue.jobs.length, 1);

    repository.rejectRunAttachments = true;
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/runs`,
      headers: { "idempotency-key": "attachments-run-v2" },
      payload: { prompt: "Build again", attachmentIds: [attachmentId] },
    });
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().error.code, "RUN_ATTACHMENTS_NOT_READY");
    assert.equal(queue.jobs.length, 1);
  } finally {
    await app.close();
  }
});

test("GET /v1/runs/:runId restores the latest resumable run state", async () => {
  const { app, repository } = await fixture();
  try {
    const run = await createProjectAndRun(repository);
    repository.setRunStatus(run.id, "PAUSED");

    const response = await app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "PAUSED");

    const missing = await app.inject({
      method: "GET",
      url: `/v1/runs/${uuid(999)}`,
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("CORS permits only an explicitly configured web origin", async () => {
  const { app } = await fixture(["http://localhost:3000"]);
  try {
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/v1/projects",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
      },
    });
    assert.equal(allowed.statusCode, 204);
    assert.equal(
      allowed.headers["access-control-allow-origin"],
      "http://localhost:3000",
    );
    const allowHeaders = String(
      allowed.headers["access-control-allow-headers"] ?? "",
    ).toLowerCase();
    assert.match(allowHeaders, /idempotency-key/);

    const denied = await app.inject({
      method: "OPTIONS",
      url: "/v1/projects",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "POST",
      },
    });
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
  }
});

test("GET /v1/runs/:runId/events replays only events after Last-Event-ID in order", async () => {
  const { app, repository } = await fixture();
  try {
    await createProjectAndRun(repository);
    repository.events.push(
      event(1, "task_started"),
      event(2, "code_generated"),
      event(3, "approval_required", {
        reason: "Approve the product and architecture plan before code generation",
      }),
    );
    repository.setRunStatus(RUN_ID, "COMPLETED");

    const response = await app.inject({
      method: "GET",
      url: `/v1/runs/${RUN_ID}/events`,
      headers: { "last-event-id": "1" },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] ?? "", /^text\/event-stream/);
    assert.doesNotMatch(response.body, /id: 1\n/);
    assert.match(response.body, /id: 2\nevent: code_generated/);
    assert.match(response.body, /id: 3\nevent: approval_required/);
    assert.match(response.body, /"scope":"plan"/);
    assert.ok(response.body.indexOf("id: 2") < response.body.indexOf("id: 3"));
  } finally {
    await app.close();
  }
});

test("SSE replay includes typed artifact.created payloads", async () => {
  const { app, repository } = await fixture();
  try {
    await createProjectAndRun(repository);
    repository.events.push(
      {
        runId: RUN_ID,
        sequence: 1,
        eventType: "artifact.created",
        payload: {
          taskId: "00000000-0000-4000-8000-000000000010",
          agent: "Sarah",
          artifactType: "seo-package",
        },
        createdAt: new Date(FIXED_NOW.getTime() + 1),
      },
      {
        runId: RUN_ID,
        sequence: 2,
        eventType: "artifact.created",
        payload: {
          version: "v1",
          taskId: "00000000-0000-4000-8000-000000000011",
          agent: "Adrian",
          artifactType: "content-package",
        },
        createdAt: new Date(FIXED_NOW.getTime() + 2),
      },
    );
    repository.setRunStatus(RUN_ID, "COMPLETED");

    const response = await app.inject({
      method: "GET",
      url: `/v1/runs/${RUN_ID}/events`,
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: artifact\.created/);
    assert.match(response.body, /"artifactType":"seo-package"/);
    assert.match(response.body, /"artifactType":"content-package"/);
    assert.match(response.body, /"version":"v1"/);
  } finally {
    await app.close();
  }
});

test("GET /v1/runs/:runId/artifacts returns ordered typed artifact envelopes", async () => {
  const { app, repository } = await fixture();
  try {
    await createProjectAndRun(repository);
    repository.events.push(
      {
        runId: RUN_ID,
        sequence: 3,
        eventType: "artifact.created",
        payload: {
          version: "v1",
          taskId: "00000000-0000-4000-8000-000000000030",
          agent: "David",
          artifactType: "david-output",
          migrationArtifactId: "00000000-0000-4000-8000-000000000099",
        },
        createdAt: new Date(FIXED_NOW.getTime() + 30),
      },
      {
        runId: RUN_ID,
        sequence: 4,
        eventType: "artifact.created",
        payload: {
          version: "v1",
          taskId: "00000000-0000-4000-8000-000000000031",
          agent: "Sarah",
          artifactType: "seo-package",
        },
        createdAt: new Date(FIXED_NOW.getTime() + 40),
      },
      {
        runId: RUN_ID,
        sequence: 5,
        eventType: "artifact.created",
        payload: {
          version: "v1",
          taskId: "00000000-0000-4000-8000-000000000032",
          agent: "Adrian",
          artifactType: "content-package",
        },
        createdAt: new Date(FIXED_NOW.getTime() + 50),
      },
      event(6, "task.completed"),
    );
    repository.artifactContentsByTaskId.set(
      "00000000-0000-4000-8000-000000000031",
      {
        version: "v1",
        sitemapXml: "<urlset></urlset>",
        robotsTxt: "User-agent: *",
        routeMetadata: [],
        findings: [],
      },
    );
    repository.artifactContentsByTaskId.set(
      "00000000-0000-4000-8000-000000000032",
      {
        version: "v1",
        audience: "Developers",
        valuePropositions: ["Ship safely"],
        ctaVariants: [],
        adVariants: [],
        claimsRequiringEvidence: [],
      },
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/runs/${RUN_ID}/artifacts`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items.length, 3);
    assert.equal(response.json().items[0].sequence, 3);
    assert.equal(response.json().items[1].payload.artifactType, "seo-package");
    assert.equal(
      response.json().items[2].payload.artifactType,
      "content-package",
    );
    assert.equal(response.json().items[1].content.sitemapXml, "<urlset></urlset>");
    assert.equal(response.json().items[2].content.audience, "Developers");
    assert.equal(
      response.json().items[0].payload.migrationArtifactId,
      "00000000-0000-4000-8000-000000000099",
    );
  } finally {
    await app.close();
  }
});

test("POST /v1/runs/:runId/actions enforces status/version CAS and queues resume", async () => {
  const { app, repository, queue } = await fixture();
  try {
    await createProjectAndRun(repository);
    const paused = await app.inject({
      method: "POST",
      url: `/v1/runs/${RUN_ID}/actions`,
      payload: {
        action: "pause",
        expectedStatus: "PENDING",
        expectedControlVersion: 0,
      },
    });
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.json().status, "PAUSED");
    assert.equal(paused.json().controlVersion, 1);

    const stale = await app.inject({
      method: "POST",
      url: `/v1/runs/${RUN_ID}/actions`,
      payload: {
        action: "resume",
        expectedStatus: "PAUSED",
        expectedControlVersion: 0,
      },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "RUN_CONCURRENCY_CONFLICT");

    const resumed = await app.inject({
      method: "POST",
      url: `/v1/runs/${RUN_ID}/actions`,
      payload: {
        action: "resume",
        expectedStatus: "PAUSED",
        expectedControlVersion: 1,
      },
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.json().status, "PENDING");
    assert.equal(resumed.json().controlVersion, 2);
    assert.deepEqual(queue.jobs, [
      { runId: RUN_ID, command: "resume", controlVersion: 2 },
    ]);
  } finally {
    await app.close();
  }
});

test("run action matrix supports approve, cancel, and retry transitions", async () => {
  const { app, repository, queue } = await fixture();
  try {
    await createProjectAndRun(repository);
    await app.inject({
      method: "POST",
      url: `/v1/runs/${RUN_ID}/actions`,
      payload: { action: "pause", expectedControlVersion: 0 },
    });
    const invalidApprove = await app.inject({
      method: "POST",
      url: `/v1/runs/${RUN_ID}/actions`,
      payload: {
        action: "approve",
        expectedStatus: "PAUSED",
        expectedControlVersion: 1,
      },
    });
    assert.equal(invalidApprove.statusCode, 400);
    assert.equal(invalidApprove.json().error.code, "VALIDATION_ERROR");

    const invalidResumeScope = await app.inject({
      method: "POST",
      url: `/v1/runs/${RUN_ID}/actions`,
      payload: {
        action: "resume",
        expectedStatus: "PAUSED",
        expectedControlVersion: 1,
        approvalScope: "plan",
      },
    });
    assert.equal(invalidResumeScope.statusCode, 400);
    assert.equal(invalidResumeScope.json().error.code, "VALIDATION_ERROR");

    const approved = await app.inject({
      method: "POST",
      url: `/v1/runs/${RUN_ID}/actions`,
      payload: {
        action: "approve",
        expectedStatus: "PAUSED",
        expectedControlVersion: 1,
        reason: "PRD approved",
        approvalScope: "plan",
      },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().status, "PENDING");

    repository.setRunStatus(RUN_ID, "RUNNING");
    const cancelled = await app.inject({
      method: "POST",
      url: `/v1/runs/${RUN_ID}/actions`,
      payload: {
        action: "cancel",
        expectedStatus: "RUNNING",
        expectedControlVersion: 2,
      },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().status, "CANCELLED");

    repository.setRunStatus(RUN_ID, "FAILED");
    const retried = await app.inject({
      method: "POST",
      url: `/v1/runs/${RUN_ID}/actions`,
      payload: {
        action: "retry",
        expectedStatus: "FAILED",
        expectedControlVersion: 3,
      },
    });
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json().status, "PENDING");
    assert.equal(retried.json().controlVersion, 4);
    assert.deepEqual(queue.jobs, [
      {
        runId: RUN_ID,
        command: "approve",
        controlVersion: 2,
        reason: "PRD approved",
        approvalScope: "plan",
      },
      { runId: RUN_ID, command: "retry", controlVersion: 4 },
    ]);
  } finally {
    await app.close();
  }
});

test("GET/PUT project file content appends revisions and rejects stale writes", async () => {
  const { app, repository } = await fixture();
  try {
    await repository.createProject({
      workspaceId: WORKSPACE_ID,
      name: "Atoms",
      slug: "atoms",
    });
    const created = await app.inject({
      method: "PUT",
      url: `/v1/projects/${PROJECT_ID}/files/content`,
      payload: {
        filePath: "app/page.tsx",
        content: "export default function Page() {}",
        expectedVersion: 0,
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().version, 1);

    const read = await app.inject({
      method: "GET",
      url: `/v1/projects/${PROJECT_ID}/files/content?filePath=app%2Fpage.tsx`,
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().version, 1);

    const updated = await app.inject({
      method: "PUT",
      url: `/v1/projects/${PROJECT_ID}/files/content`,
      payload: {
        filePath: "app/page.tsx",
        content: "export default function Page() { return null; }",
        expectedVersion: 1,
      },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().version, 2);

    const listed = await app.inject({
      method: "GET",
      url: `/v1/projects/${PROJECT_ID}/files`,
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().items, [
      {
        id: updated.json().id,
        projectId: PROJECT_ID,
        filePath: "app/page.tsx",
        version: 2,
        createdAt: FIXED_NOW.toISOString(),
        updatedAt: FIXED_NOW.toISOString(),
      },
    ]);

    const stale = await app.inject({
      method: "PUT",
      url: `/v1/projects/${PROJECT_ID}/files/content`,
      payload: {
        filePath: "app/page.tsx",
        content: "stale",
        expectedVersion: 1,
      },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "PROJECT_FILE_VERSION_CONFLICT");
    assert.equal(stale.json().error.details.actualVersion, 2);
  } finally {
    await app.close();
  }
});

test("queue failure is compensated by marking a persisted run FAILED", async () => {
  const { app, repository, queue } = await fixture();
  try {
    await repository.createProject({
      workspaceId: WORKSPACE_ID,
      name: "Atoms",
      slug: "atoms",
    });
    queue.fail = true;
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/runs`,
      headers: { "idempotency-key": "queue-failure-v1" },
      payload: { prompt: "Build a CRM" },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "RUN_QUEUE_UNAVAILABLE");
    assert.equal((await repository.getRun("user-test", RUN_ID))?.status, "FAILED");
  } finally {
    await app.close();
  }
});

function event(
  sequence: number,
  eventType: RunEventRecord["eventType"],
  payload: JsonValue = { sequence },
): RunEventRecord {
  return {
    runId: RUN_ID,
    sequence,
    eventType,
    payload,
    createdAt: new Date(FIXED_NOW.getTime() + sequence),
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

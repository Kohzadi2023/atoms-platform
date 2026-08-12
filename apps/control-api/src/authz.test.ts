import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentRunStatus,
  CreateProjectInput,
  FileContentInput,
  JsonValue,
  ProvisionDatabaseInput,
  WorkspaceRole,
} from "@atoms/contracts";

import { buildControlApi } from "./app.js";
import { StaticTokenAuthenticator, type AuthenticatedPrincipal } from "./auth.js";
import type { AttachmentRecord } from "./attachment-domain.js";
import type { AttachmentScanQueue } from "./attachment-queue.js";
import type {
  AttachmentRepository,
  CompleteAttachmentResult,
  CreateAttachmentResult,
} from "./attachment-repository.js";
import type {
  DatabaseInstanceRecord,
  MigrationArtifactRecord,
} from "./database-domain.js";
import type { DatabaseOperationQueue } from "./database-operation-queue.js";
import type {
  CreateDatabaseOperationResult,
  DatabaseControlRepository,
  DestroyDatabaseOperationResult,
} from "./database-repository.js";
import type {
  ProjectFileRecord,
  ProjectRecord,
  RunArtifactRecord,
  RunEventRecord,
  RunJob,
  RunRecord,
  RunStatusPatch,
} from "./domain.js";
import type {
  ControlRepository,
  CreateRunWithIdempotencyResult,
  PutProjectFileResult,
  WorkspaceMembershipRecord,
} from "./repository.js";
import type { RunQueue } from "./run-queue.js";

const WORKSPACE_A = "00000000-0000-4000-8000-000000000201";
const WORKSPACE_B = "00000000-0000-4000-8000-000000000202";
const PROJECT_A = "00000000-0000-4000-8000-000000000203";
const PROJECT_B = "00000000-0000-4000-8000-000000000204";
const RUN_A = "00000000-0000-4000-8000-000000000205";
const RUN_B = "00000000-0000-4000-8000-000000000206";
const ATTACHMENT_A = "00000000-0000-4000-8000-000000000207";
const DATABASE_A = "00000000-0000-4000-8000-000000000208";
const DATABASE_B = "00000000-0000-4000-8000-000000000209";
const ARTIFACT_A = "00000000-0000-4000-8000-000000000210";
const NOW = new Date("2026-08-11T10:00:00.000Z");

const TOKENS = {
  owner: "token-owner-0001",
  admin: "token-admin-0001",
  member: "token-member-0001",
  outsider: "token-outsider-0001",
} as const;

const USERS = {
  owner: "user-owner",
  admin: "user-admin",
  member: "user-member",
  outsider: "user-outsider",
} as const;

const WORKSPACE_MEMBERSHIPS: Record<string, readonly WorkspaceMembershipRecord[]> = {
  [USERS.owner]: [
    {
      workspace: { id: WORKSPACE_A, name: "Workspace A", slug: "workspace-a" },
      role: "OWNER",
    },
  ],
  [USERS.admin]: [
    {
      workspace: { id: WORKSPACE_A, name: "Workspace A", slug: "workspace-a" },
      role: "ADMIN",
    },
  ],
  [USERS.member]: [
    {
      workspace: { id: WORKSPACE_A, name: "Workspace A", slug: "workspace-a" },
      role: "MEMBER",
    },
  ],
  [USERS.outsider]: [
    {
      workspace: { id: WORKSPACE_B, name: "Workspace B", slug: "workspace-b" },
      role: "OWNER",
    },
  ],
};

function principal(userId: string): AuthenticatedPrincipal {
  const now = Math.floor(NOW.getTime() / 1_000);
  return {
    userId,
    subject: userId,
    issuer: "https://issuer.example.test/",
    audience: ["atoms-control-api"],
    issuedAt: now,
    notBefore: now,
    expiresAt: now + 3600,
  };
}

function roleForWorkspace(
  userId: string,
  workspaceId: string,
): WorkspaceRole | null {
  const membership = WORKSPACE_MEMBERSHIPS[userId]?.find(
    (entry) => entry.workspace.id === workspaceId,
  );
  return membership?.role ?? null;
}

class MemoryControlRepository implements ControlRepository {
  readonly projects = new Map<string, ProjectRecord>([
    [
      PROJECT_A,
      {
        id: PROJECT_A,
        workspaceId: WORKSPACE_A,
        name: "Project A",
        slug: "project-a",
        description: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
      },
    ],
    [
      PROJECT_B,
      {
        id: PROJECT_B,
        workspaceId: WORKSPACE_B,
        name: "Project B",
        slug: "project-b",
        description: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
      },
    ],
  ]);

  readonly runs = new Map<string, RunRecord>([
    [
      RUN_A,
      {
        id: RUN_A,
        workspaceId: WORKSPACE_A,
        projectId: PROJECT_A,
        status: "PENDING",
        prompt: "Build A",
        eventSequence: 0,
        controlVersion: 0,
        error: null,
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: null,
        pausedAt: null,
        completedAt: null,
        cancelledAt: null,
      },
    ],
    [
      RUN_B,
      {
        id: RUN_B,
        workspaceId: WORKSPACE_B,
        projectId: PROJECT_B,
        status: "PENDING",
        prompt: "Build B",
        eventSequence: 0,
        controlVersion: 0,
        error: null,
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: null,
        pausedAt: null,
        completedAt: null,
        cancelledAt: null,
      },
    ],
  ]);

  readonly events: RunEventRecord[] = [
    {
      runId: RUN_A,
      sequence: 1,
      eventType: "task_started",
      payload: { ok: true },
      createdAt: NOW,
    },
  ];

  readonly files: ProjectFileRecord[] = [
    {
      id: "00000000-0000-4000-8000-000000000211",
      projectId: PROJECT_A,
      filePath: "README.md",
      content: "hello",
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "00000000-0000-4000-8000-000000000212",
      projectId: PROJECT_B,
      filePath: "README.md",
      content: "hello",
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];

  readonly runByIdempotency = new Map<string, RunRecord>();

  async listWorkspaceMemberships(
    userId: string,
  ): Promise<readonly WorkspaceMembershipRecord[]> {
    return WORKSPACE_MEMBERSHIPS[userId] ?? [];
  }

  async getWorkspaceMembership(
    userId: string,
    workspaceId: string,
  ): Promise<WorkspaceMembershipRecord | null> {
    return (
      WORKSPACE_MEMBERSHIPS[userId]?.find(
        (membership) => membership.workspace.id === workspaceId,
      ) ?? null
    );
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const project: ProjectRecord = {
      id: "00000000-0000-4000-8000-000000000230",
      workspaceId: input.workspaceId,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
    };
    this.projects.set(project.id, project);
    return project;
  }

  async getProject(userId: string, projectId: string): Promise<ProjectRecord | null> {
    const project = this.projects.get(projectId) ?? null;
    if (project === null) return null;
    return roleForWorkspace(userId, project.workspaceId) === null ? null : project;
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
      `legacy-${Date.now()}`,
      attachmentIds,
    );
    return result.kind === "ok" ? result.run : null;
  }

  async createRunWithIdempotency(
    userId: string,
    projectId: string,
    prompt: string,
    idempotencyKey: string,
    _attachmentIds: readonly string[] = [],
  ): Promise<CreateRunWithIdempotencyResult> {
    const project = await this.getProject(userId, projectId);
    if (project === null) return { kind: "project_not_found" };

    const existing = this.runByIdempotency.get(idempotencyKey);
    if (existing !== undefined) {
      if (existing.projectId !== projectId || existing.prompt !== prompt) {
        return { kind: "idempotency_conflict", run: existing };
      }
      return { kind: "ok", run: existing, replayed: true };
    }

    const run: RunRecord = {
      id: "00000000-0000-4000-8000-000000000240",
      workspaceId: project.workspaceId,
      projectId,
      status: "PENDING",
      prompt,
      eventSequence: 0,
      controlVersion: 0,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: null,
      pausedAt: null,
      completedAt: null,
      cancelledAt: null,
    };
    this.runs.set(run.id, run);
    this.runByIdempotency.set(idempotencyKey, run);
    return { kind: "ok", run, replayed: false };
  }

  async getRun(userId: string, runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId) ?? null;
    if (run === null) return null;
    return roleForWorkspace(userId, run.workspaceId) === null ? null : run;
  }

  async transitionRun(
    userId: string,
    runId: string,
    expectedStatus: AgentRunStatus,
    expectedControlVersion: number,
    patch: RunStatusPatch,
  ): Promise<RunRecord | null> {
    const current = await this.getRun(userId, runId);
    if (
      current === null ||
      current.status !== expectedStatus ||
      current.controlVersion !== expectedControlVersion
    ) {
      return null;
    }

    const updated: RunRecord = {
      ...current,
      status: patch.status,
      controlVersion: current.controlVersion + 1,
      ...(patch.pausedAt === undefined ? {} : { pausedAt: patch.pausedAt }),
      ...(patch.completedAt === undefined ? {} : { completedAt: patch.completedAt }),
      ...(patch.cancelledAt === undefined ? {} : { cancelledAt: patch.cancelledAt }),
      ...(patch.startedAt === undefined ? {} : { startedAt: patch.startedAt }),
      ...(patch.error === undefined ? {} : { error: patch.error }),
      updatedAt: NOW,
    };
    this.runs.set(runId, updated);
    return updated;
  }

  async markRunFailed(
    _runId: string,
    _expectedControlVersion: number,
    _error: JsonValue,
  ): Promise<void> {}

  async listRunEventsAfter(
    userId: string,
    runId: string,
    sequence: number,
  ): Promise<readonly RunEventRecord[]> {
    const run = await this.getRun(userId, runId);
    if (run === null) return [];
    return this.events.filter(
      (event) => event.runId === run.id && event.sequence > sequence,
    );
  }

  async listRunArtifacts(
    userId: string,
    runId: string,
  ): Promise<readonly RunArtifactRecord[]> {
    const run = await this.getRun(userId, runId);
    if (run === null) return [];
    return [
      {
        sequence: 1,
        payload: {
          version: "v1",
          taskId: "00000000-0000-4000-8000-000000000299",
          agent: "Sarah",
          artifactType: "seo-package",
        },
        createdAt: NOW,
      },
    ];
  }

  async listProjectFiles(
    userId: string,
    projectId: string,
  ): Promise<readonly ProjectFileRecord[] | null> {
    const project = await this.getProject(userId, projectId);
    if (project === null) return null;
    return this.files.filter((file) => file.projectId === projectId);
  }

  async getProjectFile(
    userId: string,
    projectId: string,
    filePath: string,
  ): Promise<ProjectFileRecord | null> {
    const project = await this.getProject(userId, projectId);
    if (project === null) return null;
    return (
      this.files.find(
        (file) => file.projectId === projectId && file.filePath === filePath,
      ) ?? null
    );
  }

  async putProjectFile(
    userId: string,
    projectId: string,
    input: FileContentInput,
  ): Promise<PutProjectFileResult> {
    const project = await this.getProject(userId, projectId);
    if (project === null) return { kind: "project_not_found" };
    const file: ProjectFileRecord = {
      id: "00000000-0000-4000-8000-000000000250",
      projectId,
      filePath: input.filePath,
      content: input.content,
      version: 2,
      createdAt: NOW,
      updatedAt: NOW,
    };
    return { kind: "ok", file };
  }

  async close(): Promise<void> {}
}

class MemoryRunQueue implements RunQueue {
  readonly jobs: RunJob[] = [];

  async enqueue(job: RunJob): Promise<void> {
    this.jobs.push(job);
  }

  async close(): Promise<void> {}
}

class MemoryAttachmentRepository implements AttachmentRepository {
  async createAttachment(input: {
    readonly userId: string;
    readonly projectId: string;
    readonly attachmentId: string;
  }): Promise<CreateAttachmentResult> {
    const workspaceId = projectWorkspaceId(input.projectId);
    if (workspaceId === null || roleForWorkspace(input.userId, workspaceId) === null) {
      return { kind: "project_not_found" };
    }
    return {
      kind: "ok",
      attachment: attachmentRecord(input.projectId, workspaceId, input.attachmentId),
    };
  }

  async listAttachments(
    userId: string,
    projectId: string,
  ): Promise<readonly AttachmentRecord[] | null> {
    const workspaceId = projectWorkspaceId(projectId);
    if (workspaceId === null || roleForWorkspace(userId, workspaceId) === null) {
      return null;
    }
    return [attachmentRecord(projectId, workspaceId, ATTACHMENT_A)];
  }

  async getAttachment(
    userId: string,
    projectId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | null> {
    const workspaceId = projectWorkspaceId(projectId);
    if (workspaceId === null || roleForWorkspace(userId, workspaceId) === null) {
      return null;
    }
    return attachmentRecord(projectId, workspaceId, attachmentId);
  }

  async completeUpload(input: {
    readonly userId: string;
    readonly projectId: string;
    readonly attachmentId: string;
  }): Promise<CompleteAttachmentResult> {
    const workspaceId = projectWorkspaceId(input.projectId);
    if (workspaceId === null || roleForWorkspace(input.userId, workspaceId) === null) {
      return { kind: "not_found" };
    }
    return {
      kind: "ok",
      attachment: {
        ...attachmentRecord(input.projectId, workspaceId, input.attachmentId),
        status: "QUARANTINED",
        scanVersion: 1,
      },
    };
  }

  async failAttachment(): Promise<void> {}

  async close(): Promise<void> {}
}

class MemoryAttachmentQueue implements AttachmentScanQueue {
  async enqueue(): Promise<void> {}
  async close(): Promise<void> {}
}

class MemoryDatabaseRepository implements DatabaseControlRepository {
  async getProjectWorkspaceMembership(
    userId: string,
    projectId: string,
  ): Promise<{ readonly workspaceId: string; readonly role: WorkspaceRole } | null> {
    const workspaceId = projectWorkspaceId(projectId);
    if (workspaceId === null) return null;
    const role = roleForWorkspace(userId, workspaceId);
    if (role === null) return null;
    return { workspaceId, role };
  }

  async createDatabaseOperation(
    userId: string,
    projectId: string,
    _idempotencyKey: string,
    _input: ProvisionDatabaseInput,
  ): Promise<CreateDatabaseOperationResult> {
    const membership = await this.getProjectWorkspaceMembership(userId, projectId);
    if (membership === null) return { kind: "project_not_found" };
    return {
      kind: "ok",
      database: databaseRecord(projectId, membership.workspaceId),
      replayed: false,
    };
  }

  async getDatabaseInstance(
    userId: string,
    projectId: string,
    databaseInstanceId: string,
  ): Promise<DatabaseInstanceRecord | null> {
    const membership = await this.getProjectWorkspaceMembership(userId, projectId);
    if (membership === null) return null;
    const record =
      databaseInstanceId === DATABASE_A || databaseInstanceId === DATABASE_B
        ? databaseRecord(projectId, membership.workspaceId, databaseInstanceId)
        : null;
    return record;
  }

  async getLatestMigrationArtifact(
    userId: string,
    projectId: string,
  ): Promise<MigrationArtifactRecord | null> {
    const membership = await this.getProjectWorkspaceMembership(userId, projectId);
    if (membership === null) return null;
    return {
      id: ARTIFACT_A,
      workspaceId: membership.workspaceId,
      projectId,
      sourceRunId: RUN_A,
      schemaPath: "prisma/schema.prisma",
      schemaHash: "a".repeat(64),
      migrationPaths: ["prisma/migrations/20260811_init/migration.sql"],
      seedPath: "prisma/seed.ts",
      destructive: false,
      policyReport: { findings: [] },
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  async requestDatabaseAction(
    userId: string,
    projectId: string,
  ): Promise<DestroyDatabaseOperationResult> {
    const membership = await this.getProjectWorkspaceMembership(userId, projectId);
    if (membership === null) return { kind: "not_found" };
    return {
      kind: "ok",
      database: { ...databaseRecord(projectId, membership.workspaceId), status: "DELETING" },
    };
  }

  async markDatabaseOperationFailed(): Promise<void> {}
}

class MemoryDatabaseQueue implements DatabaseOperationQueue {
  async enqueue(): Promise<void> {}
  async close(): Promise<void> {}
}

function projectWorkspaceId(projectId: string): string | null {
  if (projectId === PROJECT_A) return WORKSPACE_A;
  if (projectId === PROJECT_B) return WORKSPACE_B;
  return null;
}

function attachmentRecord(
  projectId: string,
  workspaceId: string,
  attachmentId: string,
): AttachmentRecord {
  return {
    id: attachmentId,
    workspaceId,
    projectId,
    fileName: "brief.pdf",
    declaredContentType: "application/pdf",
    detectedContentType: null,
    sizeBytes: 128,
    quarantineObjectKey: `tenants/${workspaceId}/projects/${projectId}/attachments/${attachmentId}/quarantine/source`,
    cleanObjectKey: null,
    etag: null,
    sha256: null,
    status: "AWAITING_UPLOAD",
    scanVersion: 0,
    failureCode: null,
    uploadExpiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    scannedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function databaseRecord(
  projectId: string,
  workspaceId: string,
  id = DATABASE_A,
): DatabaseInstanceRecord {
  return {
    id,
    operationId: "00000000-0000-4000-8000-000000000260",
    workspaceId,
    projectId,
    migrationArtifactId: ARTIFACT_A,
    provider: "SUPABASE",
    externalId: null,
    displayName: "db",
    databaseName: null,
    region: "americas",
    status: "QUEUED",
    operationVersion: 0,
    attempt: 0,
    recoveryCount: 0,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastHeartbeatAt: NOW,
    lastSyncedAt: null,
    readyAt: null,
    deletedAt: null,
  };
}

async function fixture() {
  const repository = new MemoryControlRepository();
  const app = await buildControlApi({
    repository,
    runQueue: new MemoryRunQueue(),
    authenticator: new StaticTokenAuthenticator(
      new Map([
        [TOKENS.owner, principal(USERS.owner)],
        [TOKENS.admin, principal(USERS.admin)],
        [TOKENS.member, principal(USERS.member)],
        [TOKENS.outsider, principal(USERS.outsider)],
      ]),
    ),
    authRequired: true,
    now: () => NOW,
    ssePollIntervalMs: 1,
    sseHeartbeatMs: 5,
    sseMaxConnectionMs: 20,
    attachmentOperations: {
      repository: new MemoryAttachmentRepository(),
      queue: new MemoryAttachmentQueue(),
      storage: {
        createUploadRequest: async () => ({
          method: "PUT",
          url: "https://example.test/upload",
          headers: {},
          expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
        }),
        createDownloadRequest: async () => ({
          method: "GET",
          url: "https://example.test/download",
          headers: {},
          expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
        }),
        headObject: async () => ({
          sizeBytes: 128,
          contentType: "application/pdf",
          etag: '"etag"',
        }),
        getObject: async () => new Uint8Array(),
        copyObject: async () => undefined,
        deleteObject: async () => undefined,
      },
    },
    databaseOperations: {
      repository: new MemoryDatabaseRepository(),
      queue: new MemoryDatabaseQueue(),
    },
  });
  return { app };
}

function authHeader(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

test("missing authorization header is rejected", async () => {
  const { app } = await fixture();
  try {
    const response = await app.inject({ method: "GET", url: `/v1/projects/${PROJECT_A}` });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "AUTHENTICATION_REQUIRED");
  } finally {
    await app.close();
  }
});

test("invalid access token is rejected", async () => {
  const { app } = await fixture();
  try {
    const response = await app.inject({
      method: "GET",
      url: `/v1/projects/${PROJECT_A}`,
      headers: authHeader("not-a-known-token"),
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "INVALID_ACCESS_TOKEN");
  } finally {
    await app.close();
  }
});

test("owner/admin/member role policy is enforced", async () => {
  const { app } = await fixture();
  try {
    const ownerCreate = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeader(TOKENS.owner),
      payload: {
        workspaceId: WORKSPACE_A,
        name: "Owner Project",
        slug: "owner-project",
      },
    });
    assert.equal(ownerCreate.statusCode, 201);

    const adminCreate = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeader(TOKENS.admin),
      payload: {
        workspaceId: WORKSPACE_A,
        name: "Admin Project",
        slug: "admin-project",
      },
    });
    assert.equal(adminCreate.statusCode, 201);

    const memberCreate = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeader(TOKENS.member),
      payload: {
        workspaceId: WORKSPACE_A,
        name: "Member Project",
        slug: "member-project",
      },
    });
    assert.equal(memberCreate.statusCode, 403);
    assert.equal(memberCreate.json().error.code, "INSUFFICIENT_WORKSPACE_ROLE");

    const memberRun = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_A}/runs`,
      headers: { ...authHeader(TOKENS.member), "idempotency-key": "member-run-v1" },
      payload: { prompt: "Run with member" },
    });
    assert.equal(memberRun.statusCode, 201);

    const memberDatabase = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_A}/databases`,
      headers: { ...authHeader(TOKENS.member), "idempotency-key": "member-db-v1" },
      payload: {
        provider: "SUPABASE",
        region: "americas",
        migrationArtifactId: ARTIFACT_A,
        confirmation: "PROVISION_DATABASE",
      },
    });
    assert.equal(memberDatabase.statusCode, 403);
    assert.equal(memberDatabase.json().error.code, "INSUFFICIENT_WORKSPACE_ROLE");
  } finally {
    await app.close();
  }
});

test("cross-workspace requests are non-enumerating across route families", async () => {
  const { app } = await fixture();
  try {
    const headers = authHeader(TOKENS.member);
    const requests = [
      { method: "GET", url: `/v1/projects/${PROJECT_B}` },
      { method: "GET", url: `/v1/runs/${RUN_B}` },
      { method: "GET", url: `/v1/runs/${RUN_B}/events` },
      { method: "GET", url: `/v1/runs/${RUN_B}/artifacts` },
      { method: "GET", url: `/v1/projects/${PROJECT_B}/files` },
      { method: "GET", url: `/v1/projects/${PROJECT_B}/attachments` },
      { method: "GET", url: `/v1/projects/${PROJECT_B}/attachments/${ATTACHMENT_A}/download` },
      { method: "GET", url: `/v1/projects/${PROJECT_B}/databases/${DATABASE_B}` },
    ] as const;

    for (const request of requests) {
      const response = await app.inject({ ...request, headers });
      assert.equal(response.statusCode, 404, `${request.method} ${request.url}`);
    }
  } finally {
    await app.close();
  }
});

test("deterministic test authenticator injection succeeds for identity endpoints", async () => {
  const { app } = await fixture();
  try {
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: authHeader(TOKENS.owner),
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().userId, USERS.owner);

    const workspaces = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: authHeader(TOKENS.owner),
    });
    assert.equal(workspaces.statusCode, 200);
    assert.equal(workspaces.json().items[0].id, WORKSPACE_A);
  } finally {
    await app.close();
  }
});

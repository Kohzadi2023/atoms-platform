import assert from "node:assert/strict";
import test from "node:test";

import type {
  CreateProjectInput,
  FileContentInput,
  JsonValue,
  WorkspaceAdminOverviewCounts,
  WorkspaceAdminProjectsPage,
  WorkspaceRole,
} from "@atoms/contracts";

import { buildControlApi } from "./app.js";
import type {
  ControlRepository,
  CreateRunWithIdempotencyResult,
  PutProjectFileResult,
  WorkspaceMembershipRecord,
} from "./repository.js";
import type { RunQueue } from "./run-queue.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000701";
const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000702";

const COUNTS: WorkspaceAdminOverviewCounts = {
  members: 4,
  owners: 1,
  admins: 1,
  projects: 2,
  activeRuns: 1,
  pausedRuns: 0,
};

const PROJECTS_PAGE: WorkspaceAdminProjectsPage = {
  total: 2,
  projects: [
    {
      id: "00000000-0000-4000-8000-000000000801",
      name: "Customer operations portal40",
      slug: "customer-operations-portal40",
      projectType: "CLIENT_PORTAL",
      createdAt: "2026-10-22T10:02:25.000Z",
      runCount: 2,
      latestRun: {
        id: "00000000-0000-4000-8000-000000000901",
        status: "COMPLETED",
        createdAt: "2026-10-22T10:02:25.000Z",
        startedAt: "2026-10-22T10:02:26.000Z",
        completedAt: "2026-10-22T10:15:07.000Z",
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000802",
      name: "Empty project",
      slug: "empty-project",
      projectType: "GENERAL",
      createdAt: "2026-10-20T08:00:00.000Z",
      runCount: 0,
      latestRun: null,
    },
  ],
};

class NoopControlRepository implements ControlRepository {
  async listWorkspaceMemberships(): Promise<readonly WorkspaceMembershipRecord[]> {
    return [];
  }
  async getWorkspaceMembership(): Promise<null> {
    return null;
  }
  async updateWorkspacePlan(): Promise<never> {
    throw new Error("not used");
  }
  async createProject(_input: CreateProjectInput): Promise<never> {
    throw new Error("not used");
  }
  async getProject(): Promise<null> {
    return null;
  }
  async createRun(): Promise<null> {
    return null;
  }
  async createRunWithIdempotency(): Promise<CreateRunWithIdempotencyResult> {
    return { kind: "project_not_found" };
  }
  async getRun(): Promise<null> {
    return null;
  }
  async transitionRun(): Promise<null> {
    return null;
  }
  async markRunFailed(
    _runId: string,
    _expectedControlVersion: number,
    _error: JsonValue,
  ): Promise<void> {}
  async listRunEventsAfter(): Promise<[]> {
    return [];
  }
  async listRunArtifacts(): Promise<[]> {
    return [];
  }
  async listProjectFiles(): Promise<null> {
    return null;
  }
  async getProjectFile(): Promise<null> {
    return null;
  }
  async putProjectFile(
    _userId: string,
    _projectId: string,
    _input: FileContentInput,
  ): Promise<PutProjectFileResult> {
    return { kind: "project_not_found" };
  }
  async close(): Promise<void> {}
}

class NoopRunQueue implements RunQueue {
  async enqueue(): Promise<void> {}
  async close(): Promise<void> {}
}

class MemoryAdminMembershipRepository {
  role: WorkspaceRole = "OWNER";

  async getWorkspaceMembership(
    _userId: string,
    workspaceId: string,
  ): Promise<WorkspaceMembershipRecord | null> {
    if (workspaceId !== WORKSPACE_ID) return null;
    return {
      workspace: { id: workspaceId, name: "Atoms", slug: "atoms" },
      role: this.role,
    };
  }
}

async function fixture() {
  const repository = new MemoryAdminMembershipRepository();
  let countsCallCount = 0;
  let projectsCallCount = 0;
  const app = await buildControlApi({
    repository: new NoopControlRepository(),
    runQueue: new NoopRunQueue(),
    authRequired: false,
    adminOperations: {
      repository,
      loadCounts: async (workspaceId) => {
        countsCallCount += 1;
        assert.equal(workspaceId, WORKSPACE_ID);
        return COUNTS;
      },
      loadProjects: async (workspaceId) => {
        projectsCallCount += 1;
        assert.equal(workspaceId, WORKSPACE_ID);
        return PROJECTS_PAGE;
      },
    },
  });
  return {
    app,
    repository,
    getCountsCallCount: () => countsCallCount,
    getProjectsCallCount: () => projectsCallCount,
  };
}

function getOverview(app: Awaited<ReturnType<typeof fixture>>["app"], workspaceId: string) {
  return app.inject({
    method: "GET",
    url: `/v1/workspaces/${workspaceId}/admin/overview`,
  });
}

test("an OWNER can read the workspace admin overview", async () => {
  const { app, getCountsCallCount } = await fixture();
  const response = await getOverview(app, WORKSPACE_ID);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    workspace: { id: WORKSPACE_ID, name: "Atoms", slug: "atoms" },
    role: "OWNER",
    counts: COUNTS,
  });
  assert.equal(getCountsCallCount(), 1);
});

test("an ADMIN can read the workspace admin overview", async () => {
  const { app, repository } = await fixture();
  repository.role = "ADMIN";
  const response = await getOverview(app, WORKSPACE_ID);
  assert.equal(response.statusCode, 200);
});

test("a MEMBER is rejected before counts are loaded", async () => {
  const { app, repository, getCountsCallCount } = await fixture();
  repository.role = "MEMBER";
  const response = await getOverview(app, WORKSPACE_ID);
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).error.code, "INSUFFICIENT_WORKSPACE_ROLE");
  assert.equal(getCountsCallCount(), 0);
});

test("a non-member workspace is reported not found, never forbidden", async () => {
  const { app, getCountsCallCount } = await fixture();
  const response = await getOverview(app, OTHER_WORKSPACE_ID);
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "WORKSPACE_ACCESS_DENIED");
  assert.equal(getCountsCallCount(), 0);
});

function getProjects(app: Awaited<ReturnType<typeof fixture>>["app"], workspaceId: string) {
  return app.inject({
    method: "GET",
    url: `/v1/workspaces/${workspaceId}/admin/projects`,
  });
}

test("an OWNER can list the workspace projects with their latest run", async () => {
  const { app, getProjectsCallCount } = await fixture();
  const response = await getProjects(app, WORKSPACE_ID);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    workspace: { id: WORKSPACE_ID, name: "Atoms", slug: "atoms" },
    total: 2,
    projects: PROJECTS_PAGE.projects,
  });
  assert.equal(getProjectsCallCount(), 1);
});

test("an ADMIN can list the workspace projects", async () => {
  const { app, repository } = await fixture();
  repository.role = "ADMIN";
  const response = await getProjects(app, WORKSPACE_ID);
  assert.equal(response.statusCode, 200);
});

test("a MEMBER is rejected before any project data is loaded", async () => {
  const { app, repository, getProjectsCallCount } = await fixture();
  repository.role = "MEMBER";
  const response = await getProjects(app, WORKSPACE_ID);
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).error.code, "INSUFFICIENT_WORKSPACE_ROLE");
  assert.equal(getProjectsCallCount(), 0);
});

test("a workspace the caller does not belong to is not found and loads nothing", async () => {
  const { app, getProjectsCallCount } = await fixture();
  const response = await getProjects(app, OTHER_WORKSPACE_ID);
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "WORKSPACE_ACCESS_DENIED");
  assert.equal(getProjectsCallCount(), 0);
});

test("a malformed workspace id is rejected without loading anything", async () => {
  const { app, getProjectsCallCount } = await fixture();
  const response = await getProjects(app, "not-a-uuid");
  assert.equal(response.statusCode, 400);
  assert.equal(getProjectsCallCount(), 0);
});

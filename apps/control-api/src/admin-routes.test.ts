import assert from "node:assert/strict";
import test from "node:test";

import type {
  CreateProjectInput,
  FileContentInput,
  JsonValue,
  WorkspaceAdminOverviewCounts,
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
    },
  });
  return { app, repository, getCountsCallCount: () => countsCallCount };
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

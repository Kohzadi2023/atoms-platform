import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "./errors.js";
import { loadWorkspaceAdminOverview } from "./admin-overview-service.js";
import type { WorkspaceMembershipRecord } from "./repository.js";

const workspaceId = "00000000-0000-4000-8000-000000000301";
const userId = "user-admin";
const workspace = {
  id: workspaceId,
  name: "Workspace A",
  slug: "workspace-a",
} as const;
const counts = {
  members: 4,
  owners: 1,
  admins: 1,
  projects: 3,
  activeRuns: 2,
} as const;

function membership(role: WorkspaceMembershipRecord["role"]): WorkspaceMembershipRecord {
  return { workspace, role };
}

function repository(record: WorkspaceMembershipRecord | null) {
  return {
    async getWorkspaceMembership(actualUserId: string, actualWorkspaceId: string) {
      assert.equal(actualUserId, userId);
      assert.equal(actualWorkspaceId, workspaceId);
      return record;
    },
  };
}

test("loadWorkspaceAdminOverview loads counts for an admin", async () => {
  let calls = 0;
  const result = await loadWorkspaceAdminOverview(
    repository(membership("ADMIN")),
    async (actualWorkspaceId) => {
      calls += 1;
      assert.equal(actualWorkspaceId, workspaceId);
      return counts;
    },
    userId,
    workspaceId,
  );

  assert.equal(calls, 1);
  assert.deepEqual(result, { workspace, role: "ADMIN", counts });
});

test("loadWorkspaceAdminOverview rejects members before loading counts", async () => {
  let calls = 0;

  await assert.rejects(
    loadWorkspaceAdminOverview(
      repository(membership("MEMBER")),
      async () => {
        calls += 1;
        return counts;
      },
      userId,
      workspaceId,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, "INSUFFICIENT_WORKSPACE_ROLE");
      return true;
    },
  );

  assert.equal(calls, 0);
});

test("loadWorkspaceAdminOverview rejects non-members before loading counts", async () => {
  let calls = 0;

  await assert.rejects(
    loadWorkspaceAdminOverview(
      repository(null),
      async () => {
        calls += 1;
        return counts;
      },
      userId,
      workspaceId,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "WORKSPACE_ACCESS_DENIED");
      return true;
    },
  );

  assert.equal(calls, 0);
});

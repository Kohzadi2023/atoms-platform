import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "./errors.js";
import { buildWorkspaceAdminOverview } from "./admin-overview.js";
import type { WorkspaceMembershipRecord } from "./repository.js";

const workspace = {
  id: "00000000-0000-4000-8000-000000000301",
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

test("buildWorkspaceAdminOverview allows owners", () => {
  const result = buildWorkspaceAdminOverview(membership("OWNER"), counts);
  assert.deepEqual(result, { workspace, role: "OWNER", counts });
});

test("buildWorkspaceAdminOverview allows admins", () => {
  const result = buildWorkspaceAdminOverview(membership("ADMIN"), counts);
  assert.deepEqual(result, { workspace, role: "ADMIN", counts });
});

test("buildWorkspaceAdminOverview rejects members", () => {
  assert.throws(
    () => buildWorkspaceAdminOverview(membership("MEMBER"), counts),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, "INSUFFICIENT_WORKSPACE_ROLE");
      assert.deepEqual(error.details, {
        role: "MEMBER",
        operation: "view_admin_overview",
        requiredRoles: ["OWNER", "ADMIN"],
      });
      return true;
    },
  );
});

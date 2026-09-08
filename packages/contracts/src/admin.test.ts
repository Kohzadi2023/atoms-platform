import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceAdminOverviewResponseSchema } from "./admin.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

test("WorkspaceAdminOverviewResponseSchema accepts a workspace-scoped administrative overview", () => {
  const parsed = WorkspaceAdminOverviewResponseSchema.parse({
    workspace: {
      id: WORKSPACE_ID,
      name: "Atoms Staging",
      slug: "atoms-staging",
    },
    role: "ADMIN",
    counts: {
      members: 3,
      owners: 1,
      admins: 1,
      projects: 4,
      activeRuns: 2,
    },
  });

  assert.equal(parsed.workspace.id, WORKSPACE_ID);
  assert.equal(parsed.role, "ADMIN");
  assert.equal(parsed.counts.activeRuns, 2);
});

test("WorkspaceAdminOverviewResponseSchema rejects negative counters", () => {
  assert.throws(() =>
    WorkspaceAdminOverviewResponseSchema.parse({
      workspace: {
        id: WORKSPACE_ID,
        name: "Atoms Staging",
        slug: "atoms-staging",
      },
      role: "OWNER",
      counts: {
        members: -1,
        owners: 1,
        admins: 0,
        projects: 0,
        activeRuns: 0,
      },
    }),
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  AdminProjectSummarySchema,
  WORKSPACE_ADMIN_PROJECTS_LIMIT,
  WorkspaceAdminOverviewResponseSchema,
  WorkspaceAdminProjectsResponseSchema,
} from "./admin.js";

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

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

const project = {
  id: PROJECT_ID,
  name: "Customer operations portal40",
  slug: "customer-operations-portal40",
  projectType: "CLIENT_PORTAL",
  createdAt: "2026-10-22T10:02:25.000Z",
  runCount: 2,
  latestRun: {
    id: RUN_ID,
    status: "COMPLETED",
    createdAt: "2026-10-22T10:02:25.000Z",
    startedAt: "2026-10-22T10:02:26.000Z",
    completedAt: "2026-10-22T10:15:07.000Z",
  },
};

test("WorkspaceAdminProjectsResponseSchema accepts a project list with and without a run", () => {
  const parsed = WorkspaceAdminProjectsResponseSchema.parse({
    workspace: { id: WORKSPACE_ID, name: "Atoms Staging", slug: "atoms-staging" },
    total: 120,
    projects: [project, { ...project, id: RUN_ID, runCount: 0, latestRun: null }],
  });

  assert.equal(parsed.total, 120);
  assert.equal(parsed.projects.length, 2);
  assert.equal(parsed.projects[1]?.latestRun, null);
  assert.equal(WORKSPACE_ADMIN_PROJECTS_LIMIT, 100);
});

test("the project summary rejects unknown fields so no project content can leak into the list", () => {
  assert.throws(() => AdminProjectSummarySchema.parse({ ...project, description: "secret" }));
  assert.throws(() =>
    AdminProjectSummarySchema.parse({
      ...project,
      latestRun: { ...project.latestRun, prompt: "the user's prompt" },
    }),
  );
});

test("the project summary rejects an unknown run status or a malformed timestamp", () => {
  assert.throws(() =>
    AdminProjectSummarySchema.parse({
      ...project,
      latestRun: { ...project.latestRun, status: "DONE" },
    }),
  );
  assert.throws(() => AdminProjectSummarySchema.parse({ ...project, createdAt: "yesterday" }));
  assert.throws(() => AdminProjectSummarySchema.parse({ ...project, runCount: -1 }));
});

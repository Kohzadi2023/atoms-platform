import assert from "node:assert/strict";
import test from "node:test";

import type { CreateProjectInput, ProjectResponse } from "@atoms/contracts";

import {
  createProjectAndVerify,
  createUniqueReadinessSlug,
  type ProjectReadinessClient,
} from "./project-readiness.js";

const input: CreateProjectInput = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  name: "Readiness project",
  slug: "readiness-project",
  description: "Project-only staging readiness",
};

function projectFor(actual: CreateProjectInput): ProjectResponse {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    workspaceId: actual.workspaceId,
    name: actual.name,
    slug: actual.slug,
    description: actual.description ?? null,
    createdAt: "2026-09-10T03:00:00.000Z",
    updatedAt: "2026-09-10T03:00:00.000Z",
    archivedAt: null,
  };
}

test("creates a unique default readiness slug and verifies without run capability", async () => {
  const calls: string[] = [];
  let createdProject: ProjectResponse | undefined;
  const client: ProjectReadinessClient = {
    async listWorkspaces() {
      calls.push("listWorkspaces");
      return { items: [] };
    },
    async createProject(actual) {
      calls.push("createProject");
      assert.equal(actual.workspaceId, input.workspaceId);
      assert.equal(actual.name, input.name);
      assert.equal(actual.slug, "readiness-project-a1b2c3d4");
      createdProject = projectFor(actual);
      return createdProject;
    },
    async getProject(projectId) {
      calls.push("getProject");
      if (createdProject === undefined) {
        throw new Error("Project must be created before readback");
      }
      assert.equal(projectId, createdProject.id);
      return createdProject;
    },
  };

  const result = await createProjectAndVerify(client, input, {
    slugSuffix: "A1B2-C3D4",
  });

  assert.equal(result.slug, "readiness-project-a1b2c3d4");
  assert.deepEqual(calls, ["createProject", "getProject"]);
  assert.equal("createRun" in client, false);
});

test("preserves an explicitly customized slug", async () => {
  const customized = { ...input, slug: "my-custom-readiness" };
  const expected = projectFor(customized);
  const client: ProjectReadinessClient = {
    async listWorkspaces() {
      return { items: [] };
    },
    async createProject(actual) {
      assert.deepEqual(actual, customized);
      return expected;
    },
    async getProject() {
      return expected;
    },
  };

  const result = await createProjectAndVerify(client, customized, {
    slugSuffix: "ignored",
  });
  assert.equal(result.slug, customized.slug);
});

test("keeps generated readiness slugs within the project slug limit", () => {
  const slug = createUniqueReadinessSlug("a".repeat(100), "ABC-123-XYZ");
  assert.equal(slug.length <= 100, true);
  assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  assert.match(slug, /abc123xyz$/u);
});

test("fails closed when readback does not match the requested workspace", async () => {
  const expected = projectFor({ ...input, slug: "readiness-project-a1b2c3d4" });
  const client: ProjectReadinessClient = {
    async listWorkspaces() {
      return { items: [] };
    },
    async createProject() {
      return expected;
    },
    async getProject() {
      return {
        ...expected,
        workspaceId: "33333333-3333-4333-8333-333333333333",
      };
    },
  };

  await assert.rejects(
    () =>
      createProjectAndVerify(client, input, {
        slugSuffix: "A1B2-C3D4",
      }),
    /could not be verified/u,
  );
});

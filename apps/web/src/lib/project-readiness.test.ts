import assert from "node:assert/strict";
import test from "node:test";

import type { CreateProjectInput, ProjectResponse } from "@atoms/contracts";

import {
  createProjectAndVerify,
  type ProjectReadinessClient,
} from "./project-readiness.js";

const input: CreateProjectInput = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  name: "Readiness project",
  slug: "readiness-project",
  description: "Project-only staging readiness",
};

const project: ProjectResponse = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: input.workspaceId,
  name: input.name,
  slug: input.slug,
  description: input.description ?? null,
  createdAt: "2026-09-10T03:00:00.000Z",
  updatedAt: "2026-09-10T03:00:00.000Z",
  archivedAt: null,
};

test("creates and verifies a project without any run capability", async () => {
  const calls: string[] = [];
  const client: ProjectReadinessClient = {
    async listWorkspaces() {
      calls.push("listWorkspaces");
      return { items: [] };
    },
    async createProject(actual) {
      calls.push("createProject");
      assert.deepEqual(actual, input);
      return project;
    },
    async getProject(projectId) {
      calls.push("getProject");
      assert.equal(projectId, project.id);
      return project;
    },
  };

  const result = await createProjectAndVerify(client, input);

  assert.deepEqual(result, project);
  assert.deepEqual(calls, ["createProject", "getProject"]);
  assert.equal("createRun" in client, false);
});

test("fails closed when readback does not match the requested workspace", async () => {
  const client: ProjectReadinessClient = {
    async listWorkspaces() {
      return { items: [] };
    },
    async createProject() {
      return project;
    },
    async getProject() {
      return {
        ...project,
        workspaceId: "33333333-3333-4333-8333-333333333333",
      };
    },
  };

  await assert.rejects(
    () => createProjectAndVerify(client, input),
    /could not be verified/u,
  );
});

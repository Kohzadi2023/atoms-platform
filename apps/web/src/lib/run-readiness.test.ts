import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectResponse } from "@atoms/contracts";

import {
  LIVE_PROVIDER_CONFIRMATION,
  MAX_ALLOWED_COST_CAD,
  prepareRunReadiness,
  validateLiveRunConsent,
  type RunReadinessClient,
} from "./run-readiness.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const project: ProjectResponse = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId,
  name: "Run readiness project",
  slug: "readiness-project-ab12cd34",
  description: "Prepared by the Atoms non-billable run-readiness surface; no run requested",
  createdAt: "2026-09-10T04:00:00.000Z",
  updatedAt: "2026-09-10T04:00:00.000Z",
  archivedAt: null,
};

test("accepts only the exact live-provider confirmation and bounded cost", () => {
  const result = validateLiveRunConsent({
    prompt: "  Build a deterministic dashboard.  ",
    maximumCostCad: MAX_ALLOWED_COST_CAD,
    providerConfirmation: LIVE_PROVIDER_CONFIRMATION,
  });

  assert.deepEqual(result.violations, []);
  assert.equal(result.normalizedPrompt, "Build a deterministic dashboard.");
});

test("rejects missing consent, empty prompt, and out-of-range cost", () => {
  const result = validateLiveRunConsent({
    prompt: "   ",
    maximumCostCad: MAX_ALLOWED_COST_CAD + 0.01,
    providerConfirmation: "yes",
  });

  assert.equal(result.violations.length, 3);
  assert.equal(result.normalizedPrompt, undefined);
});

test("prepares a verified project without any run capability", async () => {
  const calls: string[] = [];
  const client: RunReadinessClient = {
    async listWorkspaces() {
      calls.push("listWorkspaces");
      return { items: [] };
    },
    async createProject(input) {
      calls.push("createProject");
      assert.equal(input.workspaceId, workspaceId);
      assert.equal(input.slug, "readiness-project-ab12cd34");
      return project;
    },
    async getProject(projectId) {
      calls.push("getProject");
      assert.equal(projectId, project.id);
      return project;
    },
  };

  const prepared = await prepareRunReadiness(
    client,
    {
      workspaceId,
      projectName: "Run readiness project",
      projectSlug: "readiness-project",
      prompt: "Build a deterministic dashboard.",
      maximumCostCad: 1,
      providerConfirmation: LIVE_PROVIDER_CONFIRMATION,
    },
    { slugSuffix: "ab12cd34" },
  );

  assert.equal(prepared.project.id, project.id);
  assert.equal(prepared.prompt, "Build a deterministic dashboard.");
  assert.equal(prepared.maximumCostCad, 1);
  assert.equal(prepared.providerConfirmation, LIVE_PROVIDER_CONFIRMATION);
  assert.deepEqual(calls, ["createProject", "getProject"]);
  assert.equal("createRun" in client, false);
});

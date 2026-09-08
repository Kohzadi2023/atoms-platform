import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@atoms/db";

import { getWorkspaceAdminOverviewCounts } from "./admin-overview-repository.js";

const workspaceId = "00000000-0000-4000-8000-000000000301";

test("getWorkspaceAdminOverviewCounts scopes every aggregate to one workspace", async () => {
  const calls: Array<{ delegate: string; args: unknown }> = [];

  const prisma = {
    membership: {
      count: async (args: unknown) => {
        calls.push({ delegate: "membership", args });
        const role = (args as { where?: { role?: string } }).where?.role;
        if (role === "OWNER") return 1;
        if (role === "ADMIN") return 2;
        return 7;
      },
    },
    project: {
      count: async (args: unknown) => {
        calls.push({ delegate: "project", args });
        return 5;
      },
    },
    agentRun: {
      count: async (args: unknown) => {
        calls.push({ delegate: "agentRun", args });
        return 3;
      },
    },
  } as unknown as PrismaClient;

  const result = await getWorkspaceAdminOverviewCounts(prisma, workspaceId);

  assert.deepEqual(result, {
    members: 7,
    owners: 1,
    admins: 2,
    projects: 5,
    activeRuns: 3,
  });

  assert.deepEqual(calls, [
    { delegate: "membership", args: { where: { workspaceId } } },
    {
      delegate: "membership",
      args: { where: { workspaceId, role: "OWNER" } },
    },
    {
      delegate: "membership",
      args: { where: { workspaceId, role: "ADMIN" } },
    },
    {
      delegate: "project",
      args: { where: { workspaceId, archivedAt: null } },
    },
    {
      delegate: "agentRun",
      args: {
        where: {
          workspaceId,
          status: { in: ["PENDING", "RUNNING", "PAUSED"] },
        },
      },
    },
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@atoms/db";

import { listWorkspaceAdminProjects } from "./admin-projects-repository.js";

const workspaceId = "00000000-0000-4000-8000-000000000401";

function fakePrisma(rows: unknown[], total: number) {
  const calls: Array<{ delegate: string; method: string; args: unknown }> = [];
  const prisma = {
    project: {
      count: async (args: unknown) => {
        calls.push({ delegate: "project", method: "count", args });
        return total;
      },
      findMany: async (args: unknown) => {
        calls.push({ delegate: "project", method: "findMany", args });
        return rows;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, calls };
}

test("lists only active projects of the requested workspace, newest first", async () => {
  const { prisma, calls } = fakePrisma([], 0);

  await listWorkspaceAdminProjects(prisma, workspaceId);

  const where = { workspaceId, archivedAt: null };
  assert.deepEqual(calls[0], { delegate: "project", method: "count", args: { where } });
  const findMany = calls[1]?.args as {
    where: unknown;
    orderBy: unknown;
    take: number;
    select: { runs: { orderBy: unknown; take: number } };
  };
  assert.deepEqual(findMany.where, where);
  assert.deepEqual(findMany.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.equal(findMany.take, 100);
  assert.deepEqual(findMany.select.runs.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.equal(findMany.select.runs.take, 1);
});

test("never writes: the fake exposes only reads and the call completes", async () => {
  const { prisma, calls } = fakePrisma([], 0);
  await listWorkspaceAdminProjects(prisma, workspaceId);
  assert.deepEqual(
    calls.map((call) => call.method).sort(),
    ["count", "findMany"],
  );
});

test("maps rows to the contract shape with ISO timestamps and the run count", async () => {
  const created = new Date("2026-10-22T10:02:25.000Z");
  const started = new Date("2026-10-22T10:02:26.000Z");
  const completed = new Date("2026-10-22T10:15:07.000Z");
  const { prisma } = fakePrisma(
    [
      {
        id: "00000000-0000-4000-8000-000000000801",
        name: "Customer operations portal40",
        slug: "customer-operations-portal40",
        projectType: "CLIENT_PORTAL",
        createdAt: created,
        _count: { runs: 3 },
        runs: [
          {
            id: "00000000-0000-4000-8000-000000000901",
            status: "COMPLETED",
            createdAt: created,
            startedAt: started,
            completedAt: completed,
          },
        ],
      },
      {
        id: "00000000-0000-4000-8000-000000000802",
        name: "Empty project",
        slug: "empty-project",
        projectType: "GENERAL",
        createdAt: created,
        _count: { runs: 0 },
        runs: [],
      },
    ],
    12,
  );

  const page = await listWorkspaceAdminProjects(prisma, workspaceId);

  assert.equal(page.total, 12);
  assert.equal(page.projects.length, 2);
  assert.deepEqual(page.projects[0], {
    id: "00000000-0000-4000-8000-000000000801",
    name: "Customer operations portal40",
    slug: "customer-operations-portal40",
    projectType: "CLIENT_PORTAL",
    createdAt: "2026-10-22T10:02:25.000Z",
    runCount: 3,
    latestRun: {
      id: "00000000-0000-4000-8000-000000000901",
      status: "COMPLETED",
      createdAt: "2026-10-22T10:02:25.000Z",
      startedAt: "2026-10-22T10:02:26.000Z",
      completedAt: "2026-10-22T10:15:07.000Z",
    },
  });
  assert.equal(page.projects[1]?.latestRun, null);
  assert.equal(page.projects[1]?.runCount, 0);
});

test("a run that has not started or finished reports null timestamps", async () => {
  const created = new Date("2026-10-22T10:02:25.000Z");
  const { prisma } = fakePrisma(
    [
      {
        id: "00000000-0000-4000-8000-000000000801",
        name: "Queued",
        slug: "queued",
        projectType: "GENERAL",
        createdAt: created,
        _count: { runs: 1 },
        runs: [
          {
            id: "00000000-0000-4000-8000-000000000902",
            status: "PENDING",
            createdAt: created,
            startedAt: null,
            completedAt: null,
          },
        ],
      },
    ],
    1,
  );

  const page = await listWorkspaceAdminProjects(prisma, workspaceId);

  assert.equal(page.projects[0]?.latestRun?.startedAt, null);
  assert.equal(page.projects[0]?.latestRun?.completedAt, null);
});

test("a custom limit is passed through, and total still counts every project", async () => {
  const { prisma, calls } = fakePrisma([], 250);

  const page = await listWorkspaceAdminProjects(prisma, workspaceId, 25);

  assert.equal((calls[1]?.args as { take: number }).take, 25);
  assert.equal(page.total, 250);
});

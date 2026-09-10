import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPrismaClient } from "@atoms/db";

import { ensurePersonalWorkspaceMembership } from "./workspace-onboarding.js";

const enabled =
  process.env.RUN_WORKSPACE_ONBOARDING_INTEGRATION_TESTS === "true" &&
  process.env.WORKSPACE_ONBOARDING_INTEGRATION_CONFIRMATION ===
    "DEDICATED_EPHEMERAL_DATABASE";

test(
  "first-workspace onboarding serializes on real PostgreSQL without raw void deserialization",
  { skip: !enabled },
  async () => {
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl, "DATABASE_URL is required for onboarding integration tests");

    const prisma = createPrismaClient(databaseUrl);
    const userId = `ci-onboarding-${randomUUID()}`;

    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          ensurePersonalWorkspaceMembership(prisma, userId),
        ),
      );

      const workspaceIds = new Set(results.map((result) => result.workspace.id));
      assert.equal(workspaceIds.size, 1);
      assert.ok(results.every((result) => result.role === "OWNER"));
      assert.ok(results.every((result) => result.workspace.name === "My Workspace"));

      const memberships = await prisma.membership.findMany({
        where: { userId },
        include: { workspace: true },
      });

      assert.equal(memberships.length, 1);
      assert.equal(memberships[0]?.role, "OWNER");
      assert.equal(memberships[0]?.workspace.name, "My Workspace");
    } finally {
      const memberships = await prisma.membership.findMany({
        where: { userId },
        select: { workspaceId: true },
      });
      const workspaceIds = memberships.map((membership) => membership.workspaceId);
      if (workspaceIds.length > 0) {
        await prisma.workspace.deleteMany({
          where: { id: { in: workspaceIds } },
        });
      }
      await prisma.$disconnect();
    }
  },
);

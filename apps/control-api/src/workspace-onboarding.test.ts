import assert from "node:assert/strict";
import test from "node:test";

import type { ControlRepository } from "./repository.js";
import {
  createPersonalWorkspaceSlug,
  ensurePersonalWorkspaceMembership,
  withPersonalWorkspaceOnboarding,
  type WorkspaceOnboardingPrisma,
} from "./workspace-onboarding.js";

const EXISTING_WORKSPACE = {
  workspace: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Existing Workspace",
    slug: "existing-workspace",
  },
  role: "MEMBER" as const,
};

function prismaFixture(options: { readonly existingAfterLock?: boolean } = {}) {
  let transactionCount = 0;
  let lockCount = 0;
  let workspaceCreateCount = 0;
  let createdUserId: string | undefined;

  const transaction = {
    async $queryRaw() {
      lockCount += 1;
      return [{ pg_advisory_xact_lock: null }];
    },
    membership: {
      async findFirst() {
        return options.existingAfterLock ? EXISTING_WORKSPACE : null;
      },
    },
    workspace: {
      async create(input: {
        readonly data: {
          readonly name: string;
          readonly slug: string;
          readonly memberships: {
            readonly create: { readonly userId: string; readonly role: string };
          };
        };
      }) {
        workspaceCreateCount += 1;
        createdUserId = input.data.memberships.create.userId;
        assert.equal(input.data.name, "My Workspace");
        assert.match(input.data.slug, /^workspace-[a-f0-9]{24}$/u);
        assert.equal(input.data.memberships.create.role, "OWNER");
        return {
          id: "00000000-0000-4000-8000-000000000002",
          name: input.data.name,
          slug: input.data.slug,
        };
      },
    },
  };

  const prisma = {
    async $transaction(operation: (client: typeof transaction) => Promise<unknown>) {
      transactionCount += 1;
      return operation(transaction);
    },
  } as unknown as WorkspaceOnboardingPrisma;

  return {
    prisma,
    metrics: () => ({
      transactionCount,
      lockCount,
      workspaceCreateCount,
      createdUserId,
    }),
  };
}

test("personal workspace slug is opaque, UUID-derived, and kebab-safe", () => {
  assert.equal(
    createPersonalWorkspaceSlug(
      () => "123e4567-e89b-12d3-a456-426614174000",
    ),
    "workspace-123e4567e89b12d3a4564266",
  );
});

test("first authenticated identity receives one isolated OWNER workspace", async () => {
  const fixture = prismaFixture();
  const membership = await ensurePersonalWorkspaceMembership(
    fixture.prisma,
    "entra-object-1",
  );

  assert.equal(membership.role, "OWNER");
  assert.equal(membership.workspace.name, "My Workspace");
  assert.deepEqual(fixture.metrics(), {
    transactionCount: 1,
    lockCount: 1,
    workspaceCreateCount: 1,
    createdUserId: "entra-object-1",
  });
});

test("concurrent onboarding reuses membership observed after the user lock", async () => {
  const fixture = prismaFixture({ existingAfterLock: true });
  const membership = await ensurePersonalWorkspaceMembership(
    fixture.prisma,
    "entra-object-2",
  );

  assert.deepEqual(membership, EXISTING_WORKSPACE);
  assert.deepEqual(fixture.metrics(), {
    transactionCount: 1,
    lockCount: 1,
    workspaceCreateCount: 0,
    createdUserId: undefined,
  });
});

test("existing workspace membership bypasses onboarding and preserves tenant assignment", async () => {
  let transactionCount = 0;
  const prisma = {
    async $transaction() {
      transactionCount += 1;
      throw new Error("onboarding transaction must not run");
    },
  } as unknown as WorkspaceOnboardingPrisma;

  const repository = {
    async listWorkspaceMemberships() {
      return [EXISTING_WORKSPACE];
    },
  } as unknown as ControlRepository;

  const decorated = withPersonalWorkspaceOnboarding(repository, prisma);
  const memberships = await decorated.listWorkspaceMemberships("existing-user");

  assert.deepEqual(memberships, [EXISTING_WORKSPACE]);
  assert.equal(transactionCount, 0);
});

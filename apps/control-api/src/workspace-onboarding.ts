import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@atoms/db";

import type {
  ControlRepository,
  WorkspaceMembershipRecord,
} from "./repository.js";

const PERSONAL_WORKSPACE_NAME = "My Workspace";
const PERSONAL_WORKSPACE_SLUG_PREFIX = "workspace-";

export interface WorkspaceOnboardingPrisma {
  readonly $transaction: PrismaClient["$transaction"];
}

export function withPersonalWorkspaceOnboarding(
  repository: ControlRepository,
  prisma: WorkspaceOnboardingPrisma,
): ControlRepository {
  return new Proxy(repository, {
    get(target, property) {
      if (property === "listWorkspaceMemberships") {
        return async (userId: string) => {
          const memberships = await target.listWorkspaceMemberships(userId);
          if (memberships.length > 0) return memberships;

          const membership = await ensurePersonalWorkspaceMembership(
            prisma,
            userId,
          );
          return [membership];
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function ensurePersonalWorkspaceMembership(
  prisma: WorkspaceOnboardingPrisma,
  userId: string,
): Promise<WorkspaceMembershipRecord> {
  return prisma.$transaction(async (transaction) => {
    // Serialize first-workspace creation per authenticated identity so parallel
    // /v1/me and /v1/workspaces requests cannot create duplicate workspaces.
    //
    // pg_advisory_xact_lock returns PostgreSQL `void`. Prisma raw-query adapters
    // cannot reliably deserialize unsupported/void output types, so materialize
    // the lock side effect in a CTE and return only a supported integer column.
    const lockRows = await transaction.$queryRaw<Array<{ locked: number }>>(
      Prisma.sql`
        WITH onboarding_lock AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))
        )
        SELECT 1::integer AS locked
        FROM onboarding_lock
      `,
    );
    if (lockRows.length !== 1 || lockRows[0]?.locked !== 1) {
      throw new Error("Could not acquire the personal workspace onboarding lock");
    }

    const existing = await transaction.membership.findFirst({
      where: { userId },
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    if (existing !== null) {
      return toWorkspaceMembership(existing);
    }

    const workspace = await transaction.workspace.create({
      data: {
        name: PERSONAL_WORKSPACE_NAME,
        slug: createPersonalWorkspaceSlug(),
        memberships: {
          create: {
            userId,
            role: "OWNER",
          },
        },
      },
      select: {
        id: true,
        name: true,
        slug: true,
      },
    });

    return {
      workspace,
      role: "OWNER",
    };
  });
}

export function createPersonalWorkspaceSlug(
  createId: () => string = randomUUID,
): string {
  const suffix = createId().replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/u.test(suffix)) {
    throw new Error("Personal workspace ID generator must return a UUID");
  }
  return `${PERSONAL_WORKSPACE_SLUG_PREFIX}${suffix.slice(0, 24)}`;
}

function toWorkspaceMembership(membership: {
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  };
  readonly role: "OWNER" | "ADMIN" | "MEMBER";
}): WorkspaceMembershipRecord {
  return {
    workspace: {
      id: membership.workspace.id,
      name: membership.workspace.name,
      slug: membership.workspace.slug,
    },
    role: membership.role,
  };
}

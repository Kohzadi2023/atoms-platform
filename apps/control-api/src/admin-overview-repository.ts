import type { WorkspaceAdminOverviewCounts } from "@atoms/contracts";
import type { PrismaClient } from "@atoms/db";

export async function getWorkspaceAdminOverviewCounts(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<WorkspaceAdminOverviewCounts> {
  const [members, owners, admins, projects, activeRuns, pausedRuns] = await Promise.all([
    prisma.membership.count({ where: { workspaceId } }),
    prisma.membership.count({ where: { workspaceId, role: "OWNER" } }),
    prisma.membership.count({ where: { workspaceId, role: "ADMIN" } }),
    prisma.project.count({ where: { workspaceId, archivedAt: null } }),
    prisma.agentRun.count({
      where: {
        workspaceId,
        status: { in: ["PENDING", "RUNNING"] },
      },
    }),
    prisma.agentRun.count({ where: { workspaceId, status: "PAUSED" } }),
  ]);

  return {
    members,
    owners,
    admins,
    projects,
    activeRuns,
    pausedRuns,
  };
}

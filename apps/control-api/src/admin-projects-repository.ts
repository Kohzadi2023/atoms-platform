import {
  WORKSPACE_ADMIN_PROJECTS_LIMIT,
  type WorkspaceAdminProjectsPage,
} from "@atoms/contracts";
import type { PrismaClient } from "@atoms/db";

/**
 * Newest active projects of one workspace with their most recent run. Reads
 * only: nothing here creates, changes or archives a project or a run.
 */
export async function listWorkspaceAdminProjects(
  prisma: PrismaClient,
  workspaceId: string,
  limit: number = WORKSPACE_ADMIN_PROJECTS_LIMIT,
): Promise<WorkspaceAdminProjectsPage> {
  const where = { workspaceId, archivedAt: null };
  const [total, rows] = await Promise.all([
    prisma.project.count({ where }),
    prisma.project.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        name: true,
        slug: true,
        projectType: true,
        createdAt: true,
        _count: { select: { runs: true } },
        runs: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            id: true,
            status: true,
            createdAt: true,
            startedAt: true,
            completedAt: true,
          },
        },
      },
    }),
  ]);

  return {
    total,
    projects: rows.map((row) => {
      const latest = row.runs[0];
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        projectType: row.projectType,
        createdAt: row.createdAt.toISOString(),
        runCount: row._count.runs,
        latestRun:
          latest === undefined
            ? null
            : {
                id: latest.id,
                status: latest.status,
                createdAt: latest.createdAt.toISOString(),
                startedAt: latest.startedAt?.toISOString() ?? null,
                completedAt: latest.completedAt?.toISOString() ?? null,
              },
      };
    }),
  };
}

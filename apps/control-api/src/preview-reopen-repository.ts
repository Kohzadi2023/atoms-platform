import type { PrismaClient } from "@atoms/db";

export type PreviewReopenTarget =
  | { readonly kind: "ok"; readonly workspaceId: string; readonly runId: string }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "no_finished_run" }
  | { readonly kind: "preview_active"; readonly expiresAt: Date };

export interface PreviewReopenRepository {
  /**
   * What a re-open of this project would target, for a user who can see it: the
   * run that received the project's last completed generation, so the new
   * preview appears in that run's event stream. A project whose preview is
   * still live has nothing to reopen.
   */
  findReopenTarget(input: {
    readonly userId: string;
    readonly projectId: string;
    readonly now: Date;
  }): Promise<PreviewReopenTarget>;
  close(): Promise<void>;
}

export class PrismaPreviewReopenRepository implements PreviewReopenRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async findReopenTarget(input: {
    readonly userId: string;
    readonly projectId: string;
    readonly now: Date;
  }): Promise<PreviewReopenTarget> {
    const project = await this.#prisma.project.findFirst({
      where: {
        id: input.projectId,
        archivedAt: null,
        workspace: { memberships: { some: { userId: input.userId } } },
      },
      select: { id: true, workspaceId: true },
    });
    if (project === null) return { kind: "project_not_found" };

    const live = await this.#prisma.previewSession.findFirst({
      where: {
        projectId: project.id,
        status: "READY",
        expiresAt: { gt: input.now },
      },
      orderBy: { expiresAt: "desc" },
      select: { expiresAt: true },
    });
    if (live !== null) return { kind: "preview_active", expiresAt: live.expiresAt };

    const run = await this.#prisma.agentRun.findFirst({
      where: { projectId: project.id, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (run === null) return { kind: "no_finished_run" };
    return { kind: "ok", workspaceId: project.workspaceId, runId: run.id };
  }

  async close(): Promise<void> {
    // The Prisma client is shared with the other repositories and closed by the
    // control repository; nothing of its own to release.
  }
}

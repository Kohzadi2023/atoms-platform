import type {
  WorkspaceAdminProjectsPage,
  WorkspaceAdminProjectsResponse,
} from "@atoms/contracts";

import { requireAdministrativeRole, workspaceAccessDeniedError } from "./authorization.js";
import type { ControlRepository } from "./repository.js";

export type WorkspaceAdminProjectsLoader = (
  workspaceId: string,
) => Promise<WorkspaceAdminProjectsPage>;

export async function loadWorkspaceAdminProjects(
  repository: Pick<ControlRepository, "getWorkspaceMembership">,
  loadProjects: WorkspaceAdminProjectsLoader,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceAdminProjectsResponse> {
  const membership = await repository.getWorkspaceMembership(userId, workspaceId);
  if (membership === null) {
    throw workspaceAccessDeniedError(workspaceId);
  }

  // Authorize before any project data is read.
  requireAdministrativeRole(membership.role, "view_admin_projects");
  const page = await loadProjects(workspaceId);
  return {
    workspace: membership.workspace,
    total: page.total,
    projects: [...page.projects],
  };
}

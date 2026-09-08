import type { WorkspaceAdminOverviewCounts, WorkspaceAdminOverviewResponse } from "@atoms/contracts";

import { requireAdministrativeRole, workspaceAccessDeniedError } from "./authorization.js";
import { buildWorkspaceAdminOverview } from "./admin-overview.js";
import type { ControlRepository } from "./repository.js";

export type WorkspaceAdminOverviewCountsLoader = (
  workspaceId: string,
) => Promise<WorkspaceAdminOverviewCounts>;

export async function loadWorkspaceAdminOverview(
  repository: Pick<ControlRepository, "getWorkspaceMembership">,
  loadCounts: WorkspaceAdminOverviewCountsLoader,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceAdminOverviewResponse> {
  const membership = await repository.getWorkspaceMembership(userId, workspaceId);
  if (membership === null) {
    throw workspaceAccessDeniedError(workspaceId);
  }

  requireAdministrativeRole(membership.role, "view_admin_overview");
  const counts = await loadCounts(workspaceId);
  return buildWorkspaceAdminOverview(membership, counts);
}

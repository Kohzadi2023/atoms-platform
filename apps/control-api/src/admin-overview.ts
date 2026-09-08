import type {
  WorkspaceAdminOverviewCounts,
  WorkspaceAdminOverviewResponse,
} from "@atoms/contracts";

import { requireAdministrativeRole } from "./authorization.js";
import type { WorkspaceMembershipRecord } from "./repository.js";

export function buildWorkspaceAdminOverview(
  membership: WorkspaceMembershipRecord,
  counts: WorkspaceAdminOverviewCounts,
): WorkspaceAdminOverviewResponse {
  requireAdministrativeRole(membership.role, "view_admin_overview");

  return {
    workspace: membership.workspace,
    role: membership.role,
    counts: {
      members: counts.members,
      owners: counts.owners,
      admins: counts.admins,
      projects: counts.projects,
      activeRuns: counts.activeRuns,
    },
  };
}

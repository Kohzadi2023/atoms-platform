import type { WorkspaceRole } from "@atoms/contracts";

import { ApiError } from "./errors.js";

const ADMINISTRATIVE_ROLES: readonly WorkspaceRole[] = ["OWNER", "ADMIN"];

export function requireAdministrativeRole(
  role: WorkspaceRole,
  operation: string,
): void {
  if (ADMINISTRATIVE_ROLES.includes(role)) {
    return;
  }
  throw insufficientWorkspaceRoleError(role, operation, ADMINISTRATIVE_ROLES);
}

export function hasAdministrativeRole(role: WorkspaceRole): boolean {
  return ADMINISTRATIVE_ROLES.includes(role);
}

export function workspaceAccessDeniedError(workspaceId?: string): ApiError {
  return new ApiError(
    404,
    "WORKSPACE_ACCESS_DENIED",
    "Workspace access denied",
    workspaceId === undefined ? undefined : { workspaceId },
  );
}

export function insufficientWorkspaceRoleError(
  role: WorkspaceRole,
  operation: string,
  requiredRoles: readonly WorkspaceRole[],
): ApiError {
  return new ApiError(
    403,
    "INSUFFICIENT_WORKSPACE_ROLE",
    "The workspace role does not allow this operation",
    {
      role,
      operation,
      requiredRoles: [...requiredRoles],
    },
  );
}

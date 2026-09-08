import { z } from "zod";

import { WorkspaceRoleSchema, WorkspaceSummarySchema } from "./api.js";

export const WorkspaceAdminOverviewCountsSchema = z
  .object({
    members: z.number().int().nonnegative(),
    owners: z.number().int().nonnegative(),
    admins: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative(),
    activeRuns: z.number().int().nonnegative(),
  })
  .strict();

export type WorkspaceAdminOverviewCounts = z.infer<
  typeof WorkspaceAdminOverviewCountsSchema
>;

export const WorkspaceAdminOverviewResponseSchema = z
  .object({
    workspace: WorkspaceSummarySchema,
    role: WorkspaceRoleSchema,
    counts: WorkspaceAdminOverviewCountsSchema,
  })
  .strict();

export type WorkspaceAdminOverviewResponse = z.infer<
  typeof WorkspaceAdminOverviewResponseSchema
>;

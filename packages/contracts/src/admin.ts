import { z } from "zod";

import {
  AgentRunStatusSchema,
  ProjectTypeSchema,
  WorkspaceRoleSchema,
  WorkspaceSummarySchema,
} from "./api.js";

const IsoTimestampSchema = z.string().datetime({ offset: true });

export const WorkspaceAdminOverviewCountsSchema = z
  .object({
    members: z.number().int().nonnegative(),
    owners: z.number().int().nonnegative(),
    admins: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative(),
    /** Runs that are pending or running. Paused runs are counted in `pausedRuns`. */
    activeRuns: z.number().int().nonnegative(),
    /** Runs waiting for a decision. One can sit here for weeks if nobody answers. */
    pausedRuns: z.number().int().nonnegative().default(0),
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

/** Newest projects returned to the admin list; `total` still counts all of them. */
export const WORKSPACE_ADMIN_PROJECTS_LIMIT = 100;

export const AdminProjectLatestRunSchema = z
  .object({
    id: z.string().uuid(),
    status: AgentRunStatusSchema,
    createdAt: IsoTimestampSchema,
    startedAt: IsoTimestampSchema.nullable(),
    completedAt: IsoTimestampSchema.nullable(),
  })
  .strict();

export type AdminProjectLatestRun = z.infer<typeof AdminProjectLatestRunSchema>;

export const AdminProjectSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    projectType: ProjectTypeSchema,
    createdAt: IsoTimestampSchema,
    runCount: z.number().int().nonnegative(),
    latestRun: AdminProjectLatestRunSchema.nullable(),
  })
  .strict();

export type AdminProjectSummary = z.infer<typeof AdminProjectSummarySchema>;

export const WorkspaceAdminProjectsPageSchema = z
  .object({
    total: z.number().int().nonnegative(),
    projects: z.array(AdminProjectSummarySchema),
  })
  .strict();

export type WorkspaceAdminProjectsPage = z.infer<
  typeof WorkspaceAdminProjectsPageSchema
>;

export const WorkspaceAdminProjectsResponseSchema = z
  .object({
    workspace: WorkspaceSummarySchema,
    total: z.number().int().nonnegative(),
    projects: z.array(AdminProjectSummarySchema),
  })
  .strict();

export type WorkspaceAdminProjectsResponse = z.infer<
  typeof WorkspaceAdminProjectsResponseSchema
>;

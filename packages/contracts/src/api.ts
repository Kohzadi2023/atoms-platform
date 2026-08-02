import { z } from "zod";

import { JsonValueSchema } from "./json.js";

const IsoTimestampSchema = z.string().datetime({ offset: true });

export const ProjectFilePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/"), {
    message: "filePath must be relative to the project root",
  })
  .refine((value) => !value.includes("\\"), {
    message: "filePath must use POSIX separators",
  })
  .refine((value) => !value.split("/").includes(".."), {
    message: "filePath must not traverse outside the project root",
  });

export const CreateProjectInputSchema = z
  .object({
    workspaceId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message: "slug must be lowercase kebab-case",
      }),
    description: z.string().trim().max(10_000).optional(),
  })
  .strict();

export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const ProjectResponseSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    archivedAt: IsoTimestampSchema.nullable(),
  })
  .strict();

export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

export const CreateRunInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(100_000),
  })
  .strict();

export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;

export const AgentRunStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const RunResponseSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    projectId: z.string().uuid(),
    status: AgentRunStatusSchema,
    prompt: z.string(),
    eventSequence: z.number().int().nonnegative(),
    controlVersion: z.number().int().nonnegative(),
    error: JsonValueSchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    startedAt: IsoTimestampSchema.nullable(),
    pausedAt: IsoTimestampSchema.nullable(),
    completedAt: IsoTimestampSchema.nullable(),
    cancelledAt: IsoTimestampSchema.nullable(),
  })
  .strict();

export type RunResponse = z.infer<typeof RunResponseSchema>;

export const RunActionSchema = z.enum([
  "approve",
  "pause",
  "resume",
  "cancel",
  "retry",
]);

export type RunAction = z.infer<typeof RunActionSchema>;

export const RunJobCommandSchema = z.enum([
  "start",
  "approve",
  "resume",
  "retry",
]);

export type RunJobCommand = z.infer<typeof RunJobCommandSchema>;

export const RUN_QUEUE_NAME = "agent-runs" as const;

/** Durable BullMQ payload shared by the Control API and orchestration worker. */
export const RunJobSchema = z
  .object({
    runId: z.string().uuid(),
    command: RunJobCommandSchema,
    controlVersion: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export type RunJob = z.infer<typeof RunJobSchema>;

export const RunActionInputSchema = z
  .object({
    action: RunActionSchema,
    expectedStatus: AgentRunStatusSchema.optional(),
    expectedControlVersion: z.number().int().nonnegative().optional(),
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export type RunActionInput = z.infer<typeof RunActionInputSchema>;

export const FileContentQuerySchema = z
  .object({
    filePath: ProjectFilePathSchema,
    version: z.coerce.number().int().positive().optional(),
  })
  .strict();

export type FileContentQuery = z.infer<typeof FileContentQuerySchema>;

export const FileContentInputSchema = z
  .object({
    filePath: ProjectFilePathSchema,
    content: z.string().max(2_000_000),
    /** Use zero when creating a path; otherwise send the latest observed version. */
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type FileContentInput = z.infer<typeof FileContentInputSchema>;

export const FileContentResponseSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    filePath: ProjectFilePathSchema,
    content: z.string(),
    version: z.number().int().positive(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();

export type FileContentResponse = z.infer<typeof FileContentResponseSchema>;

export const ProjectFileSummarySchema = FileContentResponseSchema.omit({
  content: true,
}).strict();

export type ProjectFileSummary = z.infer<typeof ProjectFileSummarySchema>;

export const ProjectFileListResponseSchema = z
  .object({
    items: z.array(ProjectFileSummarySchema).max(10_000),
  })
  .strict();

export type ProjectFileListResponse = z.infer<
  typeof ProjectFileListResponseSchema
>;

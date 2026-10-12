import { z } from "zod";

/**
 * Re-opening the preview of a finished project. A preview lives only as long as
 * its sandbox (SANDBOX_IDLE_TIMEOUT_MS), so after that the project's saved files
 * are restored into a fresh sandbox and only the steps a preview needs are run
 * (install, build, local database, start). No agent runs and no model is called.
 */
export const PREVIEW_REOPEN_QUEUE_NAME = "preview-reopens" as const;

export const PreviewReopenJobSchema = z
  .object({
    projectId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    /** The finished run whose event stream receives the new preview.updated event. */
    runId: z.string().uuid(),
  })
  .strict();

export type PreviewReopenJob = z.infer<typeof PreviewReopenJobSchema>;

export const PreviewReopenResponseSchema = z
  .object({
    status: z.literal("REQUESTED"),
    runId: z.string().uuid(),
  })
  .strict();

export type PreviewReopenResponse = z.infer<typeof PreviewReopenResponseSchema>;

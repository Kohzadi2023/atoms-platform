import { z } from "zod";

export const MAX_PROJECT_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_UPLOAD_TTL_SECONDS = 15 * 60;
export const ATTACHMENT_DOWNLOAD_TTL_SECONDS = 5 * 60;

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export const AttachmentMimeTypeSchema = z.enum(
  ALLOWED_ATTACHMENT_MIME_TYPES,
);
export type AttachmentMimeType = z.infer<typeof AttachmentMimeTypeSchema>;

export const AttachmentStatusSchema = z.enum([
  "AWAITING_UPLOAD",
  "QUARANTINED",
  "SCANNING",
  "CLEAN",
  "REJECTED",
  "FAILED",
  "EXPIRED",
]);
export type AttachmentStatus = z.infer<typeof AttachmentStatusSchema>;

export const AttachmentFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "fileName must not contain control characters",
  })
  .refine((value) => !value.includes("/") && !value.includes("\\"), {
    message: "fileName must not contain path separators",
  })
  .refine((value) => value !== "." && value !== "..", {
    message: "fileName must not be a relative path segment",
  });

export const CreateAttachmentUploadIntentInputSchema = z
  .object({
    fileName: AttachmentFileNameSchema,
    contentType: AttachmentMimeTypeSchema,
    sizeBytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  })
  .strict();
export type CreateAttachmentUploadIntentInput = z.infer<
  typeof CreateAttachmentUploadIntentInputSchema
>;

const IsoTimestampSchema = z.string().datetime({ offset: true });

export const ProjectAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    fileName: AttachmentFileNameSchema,
    contentType: AttachmentMimeTypeSchema,
    detectedContentType: AttachmentMimeTypeSchema.nullable(),
    sizeBytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
    status: AttachmentStatusSchema,
    failureCode: z.string().max(100).nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    scannedAt: IsoTimestampSchema.nullable(),
  })
  .strict();
export type ProjectAttachment = z.infer<typeof ProjectAttachmentSchema>;

export const AttachmentUploadIntentResponseSchema = z
  .object({
    attachment: ProjectAttachmentSchema,
    upload: z
      .object({
        method: z.literal("PUT"),
        url: z.string().url(),
        headers: z.record(z.string(), z.string()),
        expiresAt: IsoTimestampSchema,
      })
      .strict(),
  })
  .strict();
export type AttachmentUploadIntentResponse = z.infer<
  typeof AttachmentUploadIntentResponseSchema
>;

export const CompleteAttachmentUploadInputSchema = z
  .object({
    etag: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type CompleteAttachmentUploadInput = z.infer<
  typeof CompleteAttachmentUploadInputSchema
>;

export const AttachmentListResponseSchema = z
  .object({ items: z.array(ProjectAttachmentSchema).max(MAX_PROJECT_ATTACHMENTS) })
  .strict();
export type AttachmentListResponse = z.infer<
  typeof AttachmentListResponseSchema
>;

export const AttachmentDownloadResponseSchema = z
  .object({
    url: z.string().url(),
    expiresAt: IsoTimestampSchema,
  })
  .strict();
export type AttachmentDownloadResponse = z.infer<
  typeof AttachmentDownloadResponseSchema
>;

export const ATTACHMENT_SCAN_QUEUE_NAME = "attachment-scans" as const;

export const AttachmentScanJobSchema = z
  .object({
    attachmentId: z.string().uuid(),
    scanVersion: z.number().int().nonnegative(),
  })
  .strict();
export type AttachmentScanJob = z.infer<typeof AttachmentScanJobSchema>;

import { randomUUID } from "node:crypto";

import {
  ATTACHMENT_DOWNLOAD_TTL_SECONDS,
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  AttachmentDownloadResponseSchema,
  AttachmentListResponseSchema,
  AttachmentUploadIntentResponseSchema,
  CompleteAttachmentUploadInputSchema,
  CreateAttachmentUploadIntentInputSchema,
  ProjectAttachmentSchema,
} from "@atoms/contracts";
import type { ObjectStorageProvider } from "@atoms/storage-provider";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { toProjectAttachment } from "./attachment-domain.js";
import type { AttachmentScanQueue } from "./attachment-queue.js";
import type { AttachmentRepository } from "./attachment-repository.js";
import { ApiError } from "./errors.js";

const ProjectParamsSchema = z.object({ id: z.string().uuid() }).strict();
const AttachmentParamsSchema = z
  .object({ id: z.string().uuid(), attachmentId: z.string().uuid() })
  .strict();

export interface AttachmentRoutesOptions {
  readonly repository: AttachmentRepository;
  readonly queue: AttachmentScanQueue;
  readonly storage: ObjectStorageProvider;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  options: AttachmentRoutesOptions,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  api.post(
    "/v1/projects/:id/attachments/upload-intents",
    {
      schema: {
        operationId: "createAttachmentUploadIntent",
        params: ProjectParamsSchema,
        body: CreateAttachmentUploadIntentInputSchema,
        response: { 201: AttachmentUploadIntentResponseSchema },
      },
    },
    async (request, reply) => {
      const attachmentId = createId();
      const createdAt = now();
      const expiresAt = new Date(
        createdAt.getTime() + ATTACHMENT_UPLOAD_TTL_SECONDS * 1_000,
      );
      const created = await options.repository.createAttachment({
        projectId: request.params.id,
        attachmentId,
        metadata: request.body,
        uploadExpiresAt: expiresAt,
      });
      if (created.kind === "project_not_found") {
        throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
      }
      if (created.kind === "limit_reached") {
        throw new ApiError(
          409,
          "ATTACHMENT_LIMIT_REACHED",
          "A project can contain at most five attachments",
        );
      }

      try {
        const upload = await options.storage.createUploadRequest({
          key: created.attachment.quarantineObjectKey,
          contentType: request.body.contentType,
          sizeBytes: request.body.sizeBytes,
          expiresInSeconds: ATTACHMENT_UPLOAD_TTL_SECONDS,
        });
        return reply.code(201).send({
          attachment: toProjectAttachment(created.attachment),
          upload: {
            method: "PUT",
            url: upload.url,
            headers: { ...upload.headers },
            expiresAt: upload.expiresAt.toISOString(),
          },
        });
      } catch (error) {
        await options.repository.failAttachment({
          projectId: request.params.id,
          attachmentId,
          expectedStatus: "AWAITING_UPLOAD",
          failureCode: "UPLOAD_SIGNING_FAILED",
        });
        throw new ApiError(
          503,
          "OBJECT_STORAGE_UNAVAILABLE",
          "The attachment upload could not be prepared",
        );
      }
    },
  );

  api.post(
    "/v1/projects/:id/attachments/:attachmentId/complete",
    {
      schema: {
        operationId: "completeAttachmentUpload",
        params: AttachmentParamsSchema,
        body: CompleteAttachmentUploadInputSchema,
        response: { 202: ProjectAttachmentSchema },
      },
    },
    async (request, reply) => {
      const attachment = await options.repository.getAttachment(
        request.params.id,
        request.params.attachmentId,
      );
      if (attachment === null) {
        throw new ApiError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");
      }
      if (attachment.status !== "AWAITING_UPLOAD") {
        throw new ApiError(
          409,
          "ATTACHMENT_STATE_CONFLICT",
          `Attachment is ${attachment.status}`,
        );
      }
      if (attachment.uploadExpiresAt <= now()) {
        await options.repository.completeUpload({
          projectId: request.params.id,
          attachmentId: attachment.id,
          etag: null,
          now: now(),
        });
        await options.storage
          .deleteObject(attachment.quarantineObjectKey)
          .catch(() => undefined);
        throw new ApiError(
          409,
          "ATTACHMENT_UPLOAD_EXPIRED",
          "The attachment upload intent has expired",
        );
      }

      let object: Awaited<ReturnType<ObjectStorageProvider["headObject"]>>;
      try {
        object = await options.storage.headObject(
          attachment.quarantineObjectKey,
        );
      } catch {
        throw new ApiError(
          503,
          "OBJECT_STORAGE_UNAVAILABLE",
          "The uploaded object could not be verified",
        );
      }
      if (object === null) {
        throw new ApiError(
          409,
          "ATTACHMENT_UPLOAD_MISSING",
          "The uploaded object was not found",
        );
      }
      const suppliedEtag = request.body.etag?.replace(/^"|"$/gu, "");
      const storedEtag = object.etag?.replace(/^"|"$/gu, "");
      if (
        object.sizeBytes !== attachment.sizeBytes ||
        object.contentType !== attachment.declaredContentType ||
        (suppliedEtag !== undefined && suppliedEtag !== storedEtag)
      ) {
        await options.repository.failAttachment({
          projectId: request.params.id,
          attachmentId: attachment.id,
          expectedStatus: "AWAITING_UPLOAD",
          failureCode: "UPLOAD_METADATA_MISMATCH",
        });
        await options.storage
          .deleteObject(attachment.quarantineObjectKey)
          .catch(() => undefined);
        throw new ApiError(
          409,
          "ATTACHMENT_UPLOAD_MISMATCH",
          "Uploaded object metadata does not match the upload intent",
        );
      }

      const completed = await options.repository.completeUpload({
        projectId: request.params.id,
        attachmentId: attachment.id,
        etag: storedEtag ?? null,
        now: now(),
      });
      if (completed.kind !== "ok") {
        if (completed.kind === "stale" && completed.status === "EXPIRED") {
          await options.storage
            .deleteObject(attachment.quarantineObjectKey)
            .catch(() => undefined);
        }
        throw new ApiError(
          completed.kind === "not_found" ? 404 : 409,
          completed.kind === "not_found"
            ? "ATTACHMENT_NOT_FOUND"
            : "ATTACHMENT_STATE_CONFLICT",
          completed.kind === "not_found"
            ? "Attachment not found"
            : `Attachment is ${completed.status}`,
        );
      }

      try {
        await options.queue.enqueue({
          attachmentId: completed.attachment.id,
          scanVersion: completed.attachment.scanVersion,
        });
      } catch {
        await options.repository.failAttachment({
          projectId: request.params.id,
          attachmentId: completed.attachment.id,
          expectedStatus: "QUARANTINED",
          failureCode: "SCAN_QUEUE_UNAVAILABLE",
        });
        await options.storage
          .deleteObject(completed.attachment.quarantineObjectKey)
          .catch(() => undefined);
        throw new ApiError(
          503,
          "ATTACHMENT_SCAN_QUEUE_UNAVAILABLE",
          "Upload was quarantined but could not be queued for scanning",
        );
      }
      return reply.code(202).send(toProjectAttachment(completed.attachment));
    },
  );

  api.get(
    "/v1/projects/:id/attachments",
    {
      schema: {
        operationId: "listProjectAttachments",
        params: ProjectParamsSchema,
        response: { 200: AttachmentListResponseSchema },
      },
    },
    async (request, reply) => {
      const attachments = await options.repository.listAttachments(
        request.params.id,
      );
      if (attachments === null) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
      }
      return reply
        .code(200)
        .send({ items: attachments.map(toProjectAttachment) });
    },
  );

  api.get(
    "/v1/projects/:id/attachments/:attachmentId/download",
    {
      schema: {
        operationId: "downloadProjectAttachment",
        params: AttachmentParamsSchema,
        response: { 200: AttachmentDownloadResponseSchema },
      },
    },
    async (request, reply) => {
      const attachment = await options.repository.getAttachment(
        request.params.id,
        request.params.attachmentId,
      );
      if (attachment === null) {
        throw new ApiError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");
      }
      if (attachment.status !== "CLEAN" || attachment.cleanObjectKey === null) {
        throw new ApiError(
          409,
          "ATTACHMENT_NOT_CLEAN",
          "Only clean attachments can be downloaded",
        );
      }
      const download = await options.storage.createDownloadRequest({
        key: attachment.cleanObjectKey,
        fileName: attachment.fileName,
        expiresInSeconds: ATTACHMENT_DOWNLOAD_TTL_SECONDS,
      });
      return reply.code(200).send({
        url: download.url,
        expiresAt: download.expiresAt.toISOString(),
      });
    },
  );
}

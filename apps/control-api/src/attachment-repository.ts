import type {
  AttachmentStatus,
  CreateAttachmentUploadIntentInput,
} from "@atoms/contracts";
import type { PrismaClient, ProjectAttachment } from "@atoms/db";

import type { AttachmentRecord } from "./attachment-domain.js";

export type CreateAttachmentResult =
  | { readonly kind: "ok"; readonly attachment: AttachmentRecord }
  | { readonly kind: "project_not_found" }
  | { readonly kind: "limit_reached" };

export type CompleteAttachmentResult =
  | { readonly kind: "ok"; readonly attachment: AttachmentRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "stale"; readonly status: AttachmentStatus };

export interface AttachmentRepository {
  createAttachment(input: {
    readonly projectId: string;
    readonly attachmentId: string;
    readonly metadata: CreateAttachmentUploadIntentInput;
    readonly uploadExpiresAt: Date;
  }): Promise<CreateAttachmentResult>;
  listAttachments(projectId: string): Promise<readonly AttachmentRecord[] | null>;
  getAttachment(
    projectId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | null>;
  completeUpload(input: {
    readonly projectId: string;
    readonly attachmentId: string;
    readonly etag: string | null;
    readonly now: Date;
  }): Promise<CompleteAttachmentResult>;
  failAttachment(input: {
    readonly projectId: string;
    readonly attachmentId: string;
    readonly expectedStatus: "AWAITING_UPLOAD" | "QUARANTINED";
    readonly failureCode: string;
  }): Promise<void>;
  close(): Promise<void>;
}

export class PrismaAttachmentRepository implements AttachmentRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  createAttachment(input: {
    readonly projectId: string;
    readonly attachmentId: string;
    readonly metadata: CreateAttachmentUploadIntentInput;
    readonly uploadExpiresAt: Date;
  }): Promise<CreateAttachmentResult> {
    return this.#prisma.$transaction(async (transaction) => {
      const project = await transaction.project.findFirst({
        where: { id: input.projectId, archivedAt: null },
        select: { id: true, workspaceId: true },
      });
      if (project === null) return { kind: "project_not_found" };

      // Serialize quota checks per project so concurrent upload intents cannot
      // both observe the same remaining slot.
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${project.id}, 0))
      `;

      const count = await transaction.projectAttachment.count({
        where: { projectId: project.id },
      });
      if (count >= 5) return { kind: "limit_reached" };

      const attachment = await transaction.projectAttachment.create({
        data: {
          id: input.attachmentId,
          workspaceId: project.workspaceId,
          projectId: project.id,
          fileName: input.metadata.fileName,
          declaredContentType: input.metadata.contentType,
          sizeBytes: input.metadata.sizeBytes,
          quarantineObjectKey: `tenants/${project.workspaceId}/projects/${project.id}/attachments/${input.attachmentId}/quarantine/source`,
          uploadExpiresAt: input.uploadExpiresAt,
        },
      });
      return { kind: "ok", attachment: toAttachmentRecord(attachment) };
    });
  }

  async listAttachments(
    projectId: string,
  ): Promise<readonly AttachmentRecord[] | null> {
    const project = await this.#prisma.project.findFirst({
      where: { id: projectId, archivedAt: null },
      select: { id: true },
    });
    if (project === null) return null;
    const attachments = await this.#prisma.projectAttachment.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    return attachments.map(toAttachmentRecord);
  }

  async getAttachment(
    projectId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | null> {
    const attachment = await this.#prisma.projectAttachment.findFirst({
      where: { id: attachmentId, projectId },
    });
    return attachment === null ? null : toAttachmentRecord(attachment);
  }

  completeUpload(input: {
    readonly projectId: string;
    readonly attachmentId: string;
    readonly etag: string | null;
    readonly now: Date;
  }): Promise<CompleteAttachmentResult> {
    return this.#prisma.$transaction(async (transaction) => {
      const current = await transaction.projectAttachment.findFirst({
        where: { id: input.attachmentId, projectId: input.projectId },
      });
      if (current === null) return { kind: "not_found" };
      if (current.status !== "AWAITING_UPLOAD") {
        return { kind: "stale", status: current.status };
      }
      if (current.uploadExpiresAt <= input.now) {
        const expired = await transaction.projectAttachment.update({
          where: { id: current.id },
          data: { status: "EXPIRED", failureCode: "UPLOAD_EXPIRED" },
        });
        return { kind: "stale", status: expired.status };
      }
      const updated = await transaction.projectAttachment.updateMany({
        where: { id: current.id, status: "AWAITING_UPLOAD", scanVersion: current.scanVersion },
        data: {
          status: "QUARANTINED",
          scanVersion: { increment: 1 },
          etag: input.etag,
          failureCode: null,
        },
      });
      if (updated.count !== 1) {
        const latest = await transaction.projectAttachment.findUniqueOrThrow({
          where: { id: current.id },
        });
        return { kind: "stale", status: latest.status };
      }
      const attachment = await transaction.projectAttachment.findUniqueOrThrow({
        where: { id: current.id },
      });
      return { kind: "ok", attachment: toAttachmentRecord(attachment) };
    });
  }

  async failAttachment(input: {
    readonly projectId: string;
    readonly attachmentId: string;
    readonly expectedStatus: "AWAITING_UPLOAD" | "QUARANTINED";
    readonly failureCode: string;
  }): Promise<void> {
    await this.#prisma.projectAttachment.updateMany({
      where: {
        id: input.attachmentId,
        projectId: input.projectId,
        status: input.expectedStatus,
      },
      data: { status: "FAILED", failureCode: input.failureCode },
    });
  }

  async close(): Promise<void> {
    await this.#prisma.$disconnect();
  }
}

function toAttachmentRecord(attachment: ProjectAttachment): AttachmentRecord {
  return {
    id: attachment.id,
    workspaceId: attachment.workspaceId,
    projectId: attachment.projectId,
    fileName: attachment.fileName,
    declaredContentType: attachment.declaredContentType,
    detectedContentType: attachment.detectedContentType,
    sizeBytes: attachment.sizeBytes,
    quarantineObjectKey: attachment.quarantineObjectKey,
    cleanObjectKey: attachment.cleanObjectKey,
    etag: attachment.etag,
    sha256: attachment.sha256,
    status: attachment.status,
    scanVersion: attachment.scanVersion,
    failureCode: attachment.failureCode,
    uploadExpiresAt: attachment.uploadExpiresAt,
    scannedAt: attachment.scannedAt,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
  };
}

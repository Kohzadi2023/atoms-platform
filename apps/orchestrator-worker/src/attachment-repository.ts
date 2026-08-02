import type { AttachmentScanJob, JsonValue } from "@atoms/contracts";
import { Prisma, type PrismaClient, type ProjectAttachment } from "@atoms/db";

export interface AttachmentScanRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly fileName: string;
  readonly declaredContentType: string;
  readonly sizeBytes: number;
  readonly quarantineObjectKey: string;
  readonly scanVersion: number;
}

export type AttachmentClaimResult =
  | { readonly kind: "ready"; readonly attachment: AttachmentScanRecord }
  | { readonly kind: "missing" }
  | { readonly kind: "stale" };

export interface AttachmentScanRepository {
  claim(job: AttachmentScanJob): Promise<AttachmentClaimResult>;
  completeClean(input: {
    readonly attachmentId: string;
    readonly scanVersion: number;
    readonly detectedContentType: string;
    readonly sha256: string;
    readonly cleanObjectKey: string;
    readonly metadata: JsonValue;
    readonly now: Date;
  }): Promise<boolean>;
  reject(input: {
    readonly attachmentId: string;
    readonly scanVersion: number;
    readonly failureCode: string;
    readonly detectedContentType?: string;
    readonly sha256?: string;
    readonly metadata: JsonValue;
    readonly now: Date;
  }): Promise<boolean>;
  fail(input: {
    readonly attachmentId: string;
    readonly scanVersion: number;
    readonly failureCode: string;
    readonly metadata: JsonValue;
    readonly now: Date;
  }): Promise<boolean>;
  close(): Promise<void>;
}

export class PrismaAttachmentScanRepository
  implements AttachmentScanRepository
{
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  claim(job: AttachmentScanJob): Promise<AttachmentClaimResult> {
    return this.#prisma.$transaction(async (transaction) => {
      const current = await transaction.projectAttachment.findUnique({
        where: { id: job.attachmentId },
      });
      if (current === null) return { kind: "missing" };
      if (
        current.scanVersion !== job.scanVersion ||
        !["QUARANTINED", "SCANNING"].includes(current.status)
      ) {
        return { kind: "stale" };
      }
      if (current.status === "QUARANTINED") {
        const claimed = await transaction.projectAttachment.updateMany({
          where: {
            id: current.id,
            status: "QUARANTINED",
            scanVersion: job.scanVersion,
          },
          data: { status: "SCANNING", failureCode: null },
        });
        if (claimed.count !== 1) return { kind: "stale" };
      }
      const attachment = await transaction.projectAttachment.findUniqueOrThrow({
        where: { id: current.id },
      });
      return { kind: "ready", attachment: toScanRecord(attachment) };
    });
  }

  async completeClean(input: {
    readonly attachmentId: string;
    readonly scanVersion: number;
    readonly detectedContentType: string;
    readonly sha256: string;
    readonly cleanObjectKey: string;
    readonly metadata: JsonValue;
    readonly now: Date;
  }): Promise<boolean> {
    const updated = await this.#prisma.projectAttachment.updateMany({
      where: {
        id: input.attachmentId,
        status: "SCANNING",
        scanVersion: input.scanVersion,
      },
      data: {
        status: "CLEAN",
        detectedContentType: input.detectedContentType,
        sha256: input.sha256,
        cleanObjectKey: input.cleanObjectKey,
        scanMetadata: toPrismaJson(input.metadata),
        failureCode: null,
        scannedAt: input.now,
      },
    });
    return updated.count === 1;
  }

  reject(input: {
    readonly attachmentId: string;
    readonly scanVersion: number;
    readonly failureCode: string;
    readonly detectedContentType?: string;
    readonly sha256?: string;
    readonly metadata: JsonValue;
    readonly now: Date;
  }): Promise<boolean> {
    return this.#finish({ ...input, status: "REJECTED" });
  }

  fail(input: {
    readonly attachmentId: string;
    readonly scanVersion: number;
    readonly failureCode: string;
    readonly metadata: JsonValue;
    readonly now: Date;
  }): Promise<boolean> {
    return this.#finish({ ...input, status: "FAILED" });
  }

  async close(): Promise<void> {
    await this.#prisma.$disconnect();
  }

  async #finish(input: {
    readonly attachmentId: string;
    readonly scanVersion: number;
    readonly failureCode: string;
    readonly detectedContentType?: string;
    readonly sha256?: string;
    readonly metadata: JsonValue;
    readonly now: Date;
    readonly status: "REJECTED" | "FAILED";
  }): Promise<boolean> {
    const updated = await this.#prisma.projectAttachment.updateMany({
      where: {
        id: input.attachmentId,
        status: "SCANNING",
        scanVersion: input.scanVersion,
      },
      data: {
        status: input.status,
        failureCode: input.failureCode,
        scanMetadata: toPrismaJson(input.metadata),
        scannedAt: input.now,
        ...(input.detectedContentType === undefined
          ? {}
          : { detectedContentType: input.detectedContentType }),
        ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      },
    });
    return updated.count === 1;
  }
}

function toScanRecord(attachment: ProjectAttachment): AttachmentScanRecord {
  return {
    id: attachment.id,
    workspaceId: attachment.workspaceId,
    projectId: attachment.projectId,
    fileName: attachment.fileName,
    declaredContentType: attachment.declaredContentType,
    sizeBytes: attachment.sizeBytes,
    quarantineObjectKey: attachment.quarantineObjectKey,
    scanVersion: attachment.scanVersion,
  };
}

function toPrismaJson(value: JsonValue): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

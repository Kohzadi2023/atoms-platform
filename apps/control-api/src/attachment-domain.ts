import type {
  AttachmentMimeType,
  AttachmentStatus,
  ProjectAttachment,
} from "@atoms/contracts";

export interface AttachmentRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly fileName: string;
  readonly declaredContentType: string;
  readonly detectedContentType: string | null;
  readonly sizeBytes: number;
  readonly quarantineObjectKey: string;
  readonly cleanObjectKey: string | null;
  readonly etag: string | null;
  readonly sha256: string | null;
  readonly status: AttachmentStatus;
  readonly scanVersion: number;
  readonly failureCode: string | null;
  readonly uploadExpiresAt: Date;
  readonly scannedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toProjectAttachment(record: AttachmentRecord): ProjectAttachment {
  return {
    id: record.id,
    projectId: record.projectId,
    fileName: record.fileName,
    contentType: record.declaredContentType as AttachmentMimeType,
    detectedContentType:
      record.detectedContentType as AttachmentMimeType | null,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    status: record.status,
    failureCode: record.failureCode,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    scannedAt: record.scannedAt?.toISOString() ?? null,
  };
}

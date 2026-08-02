import {
  AttachmentMimeTypeSchema,
  AttachmentScanJobSchema,
  type AttachmentScanJob,
} from "@atoms/contracts";
import {
  calculateSha256,
  detectAttachmentMimeType,
  type MalwareScanner,
  type ObjectStorageProvider,
} from "@atoms/storage-provider";

import type { AttachmentScanRepository } from "./attachment-repository.js";

export interface AttachmentScanAttempt {
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type AttachmentScanOutcome =
  | "clean"
  | "rejected"
  | "failed"
  | "missing"
  | "stale";

export interface AttachmentProcessorOptions {
  readonly repository: AttachmentScanRepository;
  readonly storage: ObjectStorageProvider;
  readonly scanner: MalwareScanner;
  readonly now?: () => Date;
}

export class AttachmentProcessor {
  readonly #repository: AttachmentScanRepository;
  readonly #storage: ObjectStorageProvider;
  readonly #scanner: MalwareScanner;
  readonly #now: () => Date;

  constructor(options: AttachmentProcessorOptions) {
    this.#repository = options.repository;
    this.#storage = options.storage;
    this.#scanner = options.scanner;
    this.#now = options.now ?? (() => new Date());
  }

  async process(
    untrustedJob: AttachmentScanJob,
    attempt: AttachmentScanAttempt,
  ): Promise<AttachmentScanOutcome> {
    const job = AttachmentScanJobSchema.parse(untrustedJob);
    const claim = await this.#repository.claim(job);
    if (claim.kind !== "ready") return claim.kind;
    const attachment = claim.attachment;

    try {
      const bytes = await this.#storage.getObject(
        attachment.quarantineObjectKey,
        attachment.sizeBytes,
      );
      if (bytes.byteLength !== attachment.sizeBytes) {
        return await this.#rejectAndDelete({
          attachmentId: attachment.id,
          scanVersion: attachment.scanVersion,
          quarantineObjectKey: attachment.quarantineObjectKey,
          failureCode: "SIZE_MISMATCH",
          metadata: {
            expectedBytes: attachment.sizeBytes,
            actualBytes: bytes.byteLength,
          },
        });
      }

      const detectedContentType = detectAttachmentMimeType(bytes);
      const sha256 = calculateSha256(bytes);
      if (
        detectedContentType === null ||
        detectedContentType !== attachment.declaredContentType
      ) {
        return await this.#rejectAndDelete({
          attachmentId: attachment.id,
          scanVersion: attachment.scanVersion,
          quarantineObjectKey: attachment.quarantineObjectKey,
          failureCode: "CONTENT_TYPE_MISMATCH",
          ...(detectedContentType === null ? {} : { detectedContentType }),
          sha256,
          metadata: {
            declaredContentType: attachment.declaredContentType,
            detectedContentType,
          },
        });
      }
      const verifiedContentType = AttachmentMimeTypeSchema.parse(
        detectedContentType,
      );
      const scan = await this.#scanner.scan(bytes);
      if (!scan.clean) {
        return await this.#rejectAndDelete({
          attachmentId: attachment.id,
          scanVersion: attachment.scanVersion,
          quarantineObjectKey: attachment.quarantineObjectKey,
          failureCode: "MALWARE_DETECTED",
          detectedContentType: verifiedContentType,
          sha256,
          metadata: { scanner: scan.scanner, signature: scan.signature },
        });
      }

      const cleanObjectKey = `tenants/${attachment.workspaceId}/projects/${attachment.projectId}/attachments/${attachment.id}/clean/${sha256}`;
      await this.#storage.copyObject({
        sourceKey: attachment.quarantineObjectKey,
        destinationKey: cleanObjectKey,
        contentType: verifiedContentType,
      });
      const committed = await this.#repository.completeClean({
        attachmentId: attachment.id,
        scanVersion: attachment.scanVersion,
        detectedContentType: verifiedContentType,
        sha256,
        cleanObjectKey,
        metadata: { scanner: scan.scanner },
        now: this.#now(),
      });
      if (!committed) {
        await this.#storage.deleteObject(cleanObjectKey).catch(() => undefined);
        return "stale";
      }
      await this.#storage
        .deleteObject(attachment.quarantineObjectKey)
        .catch(() => undefined);
      return "clean";
    } catch (error) {
      if (attempt.attempt < attempt.maxAttempts) throw error;
      await this.#repository.fail({
        attachmentId: attachment.id,
        scanVersion: attachment.scanVersion,
        failureCode: "SCAN_PROVIDER_FAILURE",
        metadata: {
          message: error instanceof Error ? error.message : "Scan failed",
        },
        now: this.#now(),
      });
      return "failed";
    }
  }

  async #rejectAndDelete(input: {
    readonly attachmentId: string;
    readonly scanVersion: number;
    readonly quarantineObjectKey: string;
    readonly failureCode: string;
    readonly detectedContentType?: string;
    readonly sha256?: string;
    readonly metadata: Record<string, string | number | null>;
  }): Promise<"rejected" | "stale"> {
    const rejected = await this.#repository.reject({
      attachmentId: input.attachmentId,
      scanVersion: input.scanVersion,
      failureCode: input.failureCode,
      ...(input.detectedContentType === undefined
        ? {}
        : { detectedContentType: input.detectedContentType }),
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      metadata: input.metadata,
      now: this.#now(),
    });
    if (rejected) {
      await this.#storage
        .deleteObject(input.quarantineObjectKey)
        .catch(() => undefined);
    }
    return rejected ? "rejected" : "stale";
  }
}

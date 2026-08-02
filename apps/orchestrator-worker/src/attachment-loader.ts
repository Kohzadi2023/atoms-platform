import { createHash } from "node:crypto";

import type { AgentReferenceAttachment } from "@atoms/agents";
import { MAX_ATTACHMENT_BYTES, MAX_PROJECT_ATTACHMENTS } from "@atoms/contracts";
import type { PrismaClient } from "@atoms/db";
import type { ObjectStorageProvider } from "@atoms/storage-provider";

const MAX_COMBINED_ATTACHMENT_BYTES =
  MAX_ATTACHMENT_BYTES * MAX_PROJECT_ATTACHMENTS;

export interface RunAttachmentLoader {
  load(runId: string): Promise<readonly AgentReferenceAttachment[]>;
}

export class PrismaRunAttachmentLoader implements RunAttachmentLoader {
  readonly #prisma: PrismaClient;
  readonly #storage: ObjectStorageProvider;

  constructor(prisma: PrismaClient, storage: ObjectStorageProvider) {
    this.#prisma = prisma;
    this.#storage = storage;
  }

  async load(runId: string): Promise<readonly AgentReferenceAttachment[]> {
    const snapshots = await this.#prisma.agentRunAttachment.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
    });
    const totalBytes = snapshots.reduce(
      (total, attachment) => total + attachment.sizeBytes,
      0,
    );
    if (
      snapshots.length > MAX_PROJECT_ATTACHMENTS ||
      totalBytes > MAX_COMBINED_ATTACHMENT_BYTES
    ) {
      throw new RangeError("Run attachment snapshot exceeds platform limits");
    }

    const result: AgentReferenceAttachment[] = [];
    for (const snapshot of snapshots) {
      const bytes = await this.#storage.getObject(
        snapshot.objectKey,
        snapshot.sizeBytes,
      );
      if (bytes.byteLength !== snapshot.sizeBytes) {
        throw new Error(
          `Attachment ${snapshot.attachmentId} size changed after scanning`,
        );
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== snapshot.sha256) {
        throw new Error(
          `Attachment ${snapshot.attachmentId} hash changed after scanning`,
        );
      }
      const dataBase64 = Buffer.from(bytes).toString("base64");
      if (
        snapshot.contentType === "application/pdf" ||
        snapshot.contentType === "text/plain"
      ) {
        result.push({
          id: snapshot.attachmentId,
          kind: "file",
          fileName: snapshot.fileName,
          mimeType: snapshot.contentType,
          dataBase64,
        });
      } else if (
        snapshot.contentType === "image/png" ||
        snapshot.contentType === "image/jpeg" ||
        snapshot.contentType === "image/webp"
      ) {
        result.push({
          id: snapshot.attachmentId,
          kind: "image",
          fileName: snapshot.fileName,
          mimeType: snapshot.contentType,
          dataBase64,
        });
      } else {
        throw new Error(
          `Attachment ${snapshot.attachmentId} has an unsupported clean MIME type`,
        );
      }
    }
    return result;
  }
}

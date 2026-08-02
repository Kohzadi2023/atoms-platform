import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@atoms/db";
import {
  calculateSha256,
  type ObjectMetadata,
  type ObjectStorageProvider,
  type SignedObjectRequest,
} from "@atoms/storage-provider";

import { PrismaRunAttachmentLoader } from "./attachment-loader.js";

const RUN_ID = "00000000-0000-4000-8000-000000000081";
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000082";

test("run attachment loader verifies the immutable snapshot and maps provider-neutral input", async () => {
  const bytes = new TextEncoder().encode("reference brief");
  const prisma = fakePrisma([
    {
      runId: RUN_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "brief.txt",
      contentType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256: calculateSha256(bytes),
      objectKey: "clean/object",
      createdAt: new Date("2026-08-02T12:00:00.000Z"),
    },
  ]);
  const loader = new PrismaRunAttachmentLoader(
    prisma,
    new LoaderStorage(bytes),
  );

  assert.deepEqual(await loader.load(RUN_ID), [
    {
      id: ATTACHMENT_ID,
      kind: "file",
      fileName: "brief.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from(bytes).toString("base64"),
    },
  ]);
});

test("run attachment loader fails closed when stored content no longer matches its hash", async () => {
  const expected = new TextEncoder().encode("expected");
  const changed = new TextEncoder().encode("modified");
  const prisma = fakePrisma([
    {
      runId: RUN_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "brief.txt",
      contentType: "text/plain",
      sizeBytes: changed.byteLength,
      sha256: calculateSha256(expected),
      objectKey: "clean/object",
      createdAt: new Date("2026-08-02T12:00:00.000Z"),
    },
  ]);
  const loader = new PrismaRunAttachmentLoader(
    prisma,
    new LoaderStorage(changed),
  );

  await assert.rejects(loader.load(RUN_ID), /hash changed after scanning/u);
});

function fakePrisma(rows: readonly unknown[]): PrismaClient {
  return {
    agentRunAttachment: {
      findMany: async () => rows,
    },
  } as unknown as PrismaClient;
}

class LoaderStorage implements ObjectStorageProvider {
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  async getObject(): Promise<Uint8Array> {
    return this.#bytes;
  }

  async createUploadRequest(): Promise<SignedObjectRequest> {
    throw new Error("not used");
  }

  async createDownloadRequest(): Promise<SignedObjectRequest> {
    throw new Error("not used");
  }

  async headObject(): Promise<ObjectMetadata | null> {
    throw new Error("not used");
  }

  async copyObject(): Promise<void> {
    throw new Error("not used");
  }

  async deleteObject(): Promise<void> {
    throw new Error("not used");
  }
}

import assert from "node:assert/strict";
import test from "node:test";

import type {
  AttachmentScanJob,
  AttachmentStatus,
  CreateAttachmentUploadIntentInput,
} from "@atoms/contracts";
import type {
  ObjectMetadata,
  ObjectStorageProvider,
  SignedObjectRequest,
} from "@atoms/storage-provider";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import type { AttachmentRecord } from "./attachment-domain.js";
import type { AttachmentScanQueue } from "./attachment-queue.js";
import type {
  AttachmentRepository,
  CompleteAttachmentResult,
  CreateAttachmentResult,
} from "./attachment-repository.js";
import { registerAttachmentRoutes } from "./attachment-routes.js";
import { ApiError } from "./errors.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000091";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000092";
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000093";
const NOW = new Date("2026-08-02T12:00:00.000Z");

test("attachment routes create a tenant-scoped intent and enqueue scanning after exact metadata verification", async () => {
  const fixture = await createFixture();
  try {
    const intent = await fixture.app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/attachments/upload-intents`,
      payload: {
        fileName: "brief.pdf",
        contentType: "application/pdf",
        sizeBytes: 128,
      },
    });
    assert.equal(intent.statusCode, 201);
    assert.equal(intent.json().attachment.status, "AWAITING_UPLOAD");
    assert.equal(intent.json().upload.headers["x-encryption"], "enabled");
    assert.equal(intent.body.includes("quarantineObjectKey"), false);
    assert.equal(
      fixture.storage.uploadKeys[0],
      `tenants/${WORKSPACE_ID}/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}/quarantine/source`,
    );

    const completed = await fixture.app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}/complete`,
      payload: { etag: "etag-1" },
    });
    assert.equal(completed.statusCode, 202);
    assert.equal(completed.json().status, "QUARANTINED");
    assert.deepEqual(fixture.queue.jobs, [
      { attachmentId: ATTACHMENT_ID, scanVersion: 1 },
    ]);
  } finally {
    await fixture.app.close();
  }
});

test("attachment completion fails closed and deletes a mismatched quarantine object", async () => {
  const fixture = await createFixture();
  try {
    await fixture.app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/attachments/upload-intents`,
      payload: {
        fileName: "brief.pdf",
        contentType: "application/pdf",
        sizeBytes: 128,
      },
    });
    fixture.storage.metadata = {
      sizeBytes: 127,
      contentType: "application/pdf",
      etag: '"etag-1"',
    };
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}/complete`,
      payload: {},
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "ATTACHMENT_UPLOAD_MISMATCH");
    assert.equal(fixture.repository.attachment?.status, "FAILED");
    assert.equal(fixture.storage.deleted.length, 1);
    assert.equal(fixture.queue.jobs.length, 0);
  } finally {
    await fixture.app.close();
  }
});

test("download routes expose short-lived URLs only for clean objects", async () => {
  const fixture = await createFixture();
  try {
    await fixture.app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/attachments/upload-intents`,
      payload: {
        fileName: "brief.pdf",
        contentType: "application/pdf",
        sizeBytes: 128,
      },
    });
    const blocked = await fixture.app.inject({
      method: "GET",
      url: `/v1/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}/download`,
    });
    assert.equal(blocked.statusCode, 409);

    fixture.repository.markClean();
    const allowed = await fixture.app.inject({
      method: "GET",
      url: `/v1/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}/download`,
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.json().url, "https://objects.example/download");
    assert.deepEqual(fixture.storage.downloadKeys, ["clean/object"]);
  } finally {
    await fixture.app.close();
  }
});

async function createFixture() {
  const repository = new MemoryAttachmentRepository();
  const queue = new MemoryAttachmentQueue();
  const storage = new MemoryStorage();
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAttachmentRoutes(app, {
    repository,
    queue,
    storage,
    now: () => NOW,
    createId: () => ATTACHMENT_ID,
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    return reply.code(500).send({ error: { code: "INTERNAL" } });
  });
  await app.ready();
  return { app, repository, queue, storage };
}

class MemoryAttachmentRepository implements AttachmentRepository {
  attachment: AttachmentRecord | undefined;

  async createAttachment(input: {
    readonly attachmentId: string;
    readonly metadata: CreateAttachmentUploadIntentInput;
  }): Promise<CreateAttachmentResult> {
    this.attachment = record({
      id: input.attachmentId,
      fileName: input.metadata.fileName,
      declaredContentType: input.metadata.contentType,
      sizeBytes: input.metadata.sizeBytes,
    });
    return { kind: "ok", attachment: this.attachment };
  }

  async listAttachments(): Promise<readonly AttachmentRecord[]> {
    return this.attachment === undefined ? [] : [this.attachment];
  }

  async getAttachment(): Promise<AttachmentRecord | null> {
    return this.attachment ?? null;
  }

  async completeUpload(): Promise<CompleteAttachmentResult> {
    if (this.attachment === undefined) return { kind: "not_found" };
    this.attachment = {
      ...this.attachment,
      status: "QUARANTINED",
      scanVersion: 1,
      etag: "etag-1",
    };
    return { kind: "ok", attachment: this.attachment };
  }

  async failAttachment(input: {
    readonly failureCode: string;
  }): Promise<void> {
    if (this.attachment !== undefined) {
      this.attachment = {
        ...this.attachment,
        status: "FAILED",
        failureCode: input.failureCode,
      };
    }
  }

  markClean(): void {
    if (this.attachment === undefined) throw new Error("fixture missing");
    this.attachment = {
      ...this.attachment,
      status: "CLEAN",
      cleanObjectKey: "clean/object",
      detectedContentType: "application/pdf",
      sha256: "a".repeat(64),
      scannedAt: NOW,
    };
  }

  async close(): Promise<void> {}
}

class MemoryAttachmentQueue implements AttachmentScanQueue {
  readonly jobs: AttachmentScanJob[] = [];

  async enqueue(job: AttachmentScanJob): Promise<void> {
    this.jobs.push(job);
  }

  async close(): Promise<void> {}
}

class MemoryStorage implements ObjectStorageProvider {
  metadata: ObjectMetadata = {
    sizeBytes: 128,
    contentType: "application/pdf",
    etag: '"etag-1"',
  };
  readonly uploadKeys: string[] = [];
  readonly downloadKeys: string[] = [];
  readonly deleted: string[] = [];

  async createUploadRequest(input: {
    readonly key: string;
  }): Promise<SignedObjectRequest> {
    this.uploadKeys.push(input.key);
    return {
      method: "PUT",
      url: "https://objects.example/upload",
      headers: { "x-encryption": "enabled" },
      expiresAt: new Date(NOW.getTime() + 900_000),
    };
  }

  async createDownloadRequest(input: {
    readonly key: string;
  }): Promise<SignedObjectRequest> {
    this.downloadKeys.push(input.key);
    return {
      method: "GET",
      url: "https://objects.example/download",
      headers: {},
      expiresAt: new Date(NOW.getTime() + 300_000),
    };
  }

  async headObject(): Promise<ObjectMetadata> {
    return this.metadata;
  }

  async getObject(): Promise<Uint8Array> {
    throw new Error("not used");
  }

  async copyObject(): Promise<void> {
    throw new Error("not used");
  }

  async deleteObject(key: string): Promise<void> {
    this.deleted.push(key);
  }
}

function record(overrides: {
  readonly id: string;
  readonly fileName: string;
  readonly declaredContentType: string;
  readonly sizeBytes: number;
  readonly status?: AttachmentStatus;
}): AttachmentRecord {
  return {
    id: overrides.id,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    fileName: overrides.fileName,
    declaredContentType: overrides.declaredContentType,
    detectedContentType: null,
    sizeBytes: overrides.sizeBytes,
    quarantineObjectKey: `tenants/${WORKSPACE_ID}/projects/${PROJECT_ID}/attachments/${overrides.id}/quarantine/source`,
    cleanObjectKey: null,
    etag: null,
    sha256: null,
    status: overrides.status ?? "AWAITING_UPLOAD",
    scanVersion: 0,
    failureCode: null,
    uploadExpiresAt: new Date(NOW.getTime() + 900_000),
    scannedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

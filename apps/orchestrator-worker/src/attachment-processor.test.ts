import assert from "node:assert/strict";
import test from "node:test";

import type { AttachmentScanJob } from "@atoms/contracts";
import type {
  MalwareScanResult,
  MalwareScanner,
  ObjectMetadata,
  ObjectStorageProvider,
  SignedObjectRequest,
} from "@atoms/storage-provider";

import { AttachmentProcessor } from "./attachment-processor.js";
import type {
  AttachmentClaimResult,
  AttachmentScanRecord,
  AttachmentScanRepository,
} from "./attachment-repository.js";

const JOB: AttachmentScanJob = {
  attachmentId: "00000000-0000-4000-8000-000000000071",
  scanVersion: 1,
};
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nreference");

test("attachment processor promotes a verified clean object and removes quarantine", async () => {
  const repository = new FakeRepository();
  const storage = new FakeStorage(PDF_BYTES);
  const processor = new AttachmentProcessor({
    repository,
    storage,
    scanner: new FakeScanner({ clean: true, scanner: "clamav" }),
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });

  assert.equal(
    await processor.process(JOB, { attempt: 1, maxAttempts: 3 }),
    "clean",
  );
  assert.equal(repository.cleanInputs.length, 1);
  assert.match(repository.cleanInputs[0]?.cleanObjectKey ?? "", /\/clean\/[a-f0-9]{64}$/u);
  assert.deepEqual(storage.deleted, ["quarantine/source"]);
  assert.equal(storage.copies.length, 1);
});

test("attachment processor rejects a declared MIME mismatch before malware scanning", async () => {
  const textBytes = new TextEncoder().encode("plain text");
  const repository = new FakeRepository({
    ...attachmentFixture(),
    sizeBytes: textBytes.byteLength,
  });
  const storage = new FakeStorage(textBytes);
  const scanner = new FakeScanner({ clean: true, scanner: "clamav" });
  const processor = new AttachmentProcessor({ repository, storage, scanner });

  assert.equal(
    await processor.process(JOB, { attempt: 1, maxAttempts: 3 }),
    "rejected",
  );
  assert.equal(repository.rejectInputs[0]?.failureCode, "CONTENT_TYPE_MISMATCH");
  assert.equal(scanner.calls, 0);
  assert.deepEqual(storage.deleted, ["quarantine/source"]);
});

test("attachment processor rejects malware and never creates a clean copy", async () => {
  const repository = new FakeRepository();
  const storage = new FakeStorage(PDF_BYTES);
  const processor = new AttachmentProcessor({
    repository,
    storage,
    scanner: new FakeScanner({
      clean: false,
      scanner: "clamav",
      signature: "Eicar-Signature",
    }),
  });

  assert.equal(
    await processor.process(JOB, { attempt: 1, maxAttempts: 3 }),
    "rejected",
  );
  assert.equal(repository.rejectInputs[0]?.failureCode, "MALWARE_DETECTED");
  assert.equal(storage.copies.length, 0);
});

test("attachment processor retries scanner outages and fails closed on exhaustion", async () => {
  const repository = new FakeRepository();
  const storage = new FakeStorage(PDF_BYTES);
  const processor = new AttachmentProcessor({
    repository,
    storage,
    scanner: new FakeScanner(new Error("scanner unavailable")),
  });

  await assert.rejects(
    processor.process(JOB, { attempt: 1, maxAttempts: 2 }),
    /scanner unavailable/u,
  );
  assert.equal(repository.failInputs.length, 0);
  assert.equal(
    await processor.process(JOB, { attempt: 2, maxAttempts: 2 }),
    "failed",
  );
  assert.equal(repository.failInputs[0]?.failureCode, "SCAN_PROVIDER_FAILURE");
});

class FakeRepository implements AttachmentScanRepository {
  readonly #attachment: AttachmentScanRecord;
  readonly cleanInputs: Array<{
    readonly cleanObjectKey: string;
  }> = [];
  readonly rejectInputs: Array<{ readonly failureCode: string }> = [];
  readonly failInputs: Array<{ readonly failureCode: string }> = [];

  constructor(attachment: AttachmentScanRecord = attachmentFixture()) {
    this.#attachment = attachment;
  }

  async claim(): Promise<AttachmentClaimResult> {
    return { kind: "ready", attachment: this.#attachment };
  }

  async completeClean(input: {
    readonly cleanObjectKey: string;
  }): Promise<boolean> {
    this.cleanInputs.push(input);
    return true;
  }

  async reject(input: { readonly failureCode: string }): Promise<boolean> {
    this.rejectInputs.push(input);
    return true;
  }

  async fail(input: { readonly failureCode: string }): Promise<boolean> {
    this.failInputs.push(input);
    return true;
  }

  async close(): Promise<void> {}
}

class FakeStorage implements ObjectStorageProvider {
  readonly #bytes: Uint8Array;
  readonly copies: Array<{ readonly destinationKey: string }> = [];
  readonly deleted: string[] = [];

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  async getObject(): Promise<Uint8Array> {
    return this.#bytes;
  }

  async copyObject(input: {
    readonly destinationKey: string;
  }): Promise<void> {
    this.copies.push(input);
  }

  async deleteObject(key: string): Promise<void> {
    this.deleted.push(key);
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
}

class FakeScanner implements MalwareScanner {
  readonly #result: MalwareScanResult | Error;
  calls = 0;

  constructor(result: MalwareScanResult | Error) {
    this.#result = result;
  }

  async scan(): Promise<MalwareScanResult> {
    this.calls += 1;
    if (this.#result instanceof Error) throw this.#result;
    return this.#result;
  }
}

function attachmentFixture(): AttachmentScanRecord {
  return {
    id: JOB.attachmentId,
    workspaceId: "00000000-0000-4000-8000-000000000072",
    projectId: "00000000-0000-4000-8000-000000000073",
    fileName: "brief.pdf",
    declaredContentType: "application/pdf",
    sizeBytes: PDF_BYTES.byteLength,
    quarantineObjectKey: "quarantine/source",
    scanVersion: JOB.scanVersion,
  };
}

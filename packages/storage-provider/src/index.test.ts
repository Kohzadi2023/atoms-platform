import assert from "node:assert/strict";
import test from "node:test";

import {
  ClamAvScanner,
  S3ObjectStorageProvider,
  calculateSha256,
  detectAttachmentMimeType,
  type ClamAvTransport,
} from "./index.js";

const bytes = (values: readonly number[]): Uint8Array =>
  Uint8Array.from(values);

test("content inspection identifies every supported binary signature", () => {
  assert.equal(
    detectAttachmentMimeType(bytes([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])),
    "application/pdf",
  );
  assert.equal(
    detectAttachmentMimeType(
      bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ),
    "image/png",
  );
  assert.equal(
    detectAttachmentMimeType(bytes([0xff, 0xd8, 0xff, 0xe0])),
    "image/jpeg",
  );
  assert.equal(
    detectAttachmentMimeType(
      bytes([
        0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45,
        0x42, 0x50,
      ]),
    ),
    "image/webp",
  );
});

test("content inspection accepts UTF-8 text and rejects binary disguises", () => {
  assert.equal(
    detectAttachmentMimeType(new TextEncoder().encode("Product brief\nمرحبا")),
    "text/plain",
  );
  assert.equal(detectAttachmentMimeType(bytes([0x00, 0x01, 0x02])), null);
  assert.equal(detectAttachmentMimeType(bytes([0xc3, 0x28])), null);
});

test("SHA-256 is deterministic", () => {
  assert.equal(
    calculateSha256(new TextEncoder().encode("atoms")),
    "bb112e00adab41da3eb94bae7e85c88c6eb4a71738ca9d3b432fabe1e91d5813",
  );
});

test("ClamAV adapter normalizes clean and infected protocol responses", async () => {
  const clean = new ClamAvScanner({ transport: new FakeTransport("stream: OK\0") });
  const infected = new ClamAvScanner({
    transport: new FakeTransport("stream: Eicar-Signature FOUND\0"),
  });

  assert.deepEqual(await clean.scan(bytes([1])), {
    clean: true,
    scanner: "clamav",
  });
  assert.deepEqual(await infected.scan(bytes([1])), {
    clean: false,
    scanner: "clamav",
    signature: "Eicar-Signature",
  });
});

test("ClamAV adapter fails closed on an unknown response", async () => {
  const scanner = new ClamAvScanner({
    transport: new FakeTransport("stream: UNKNOWN ERROR\0"),
  });
  await assert.rejects(scanner.scan(bytes([1])), /Unexpected ClamAV response/u);
});

test("S3 presigned requests use the public signing endpoint", async () => {
  const provider = new S3ObjectStorageProvider({
    bucket: "atoms-attachments",
    region: "us-east-1",
    endpoint: "http://minio:9000",
    signingEndpoint: "https://storage.staging.atoms.dev",
    forcePathStyle: true,
    accessKeyId: "atoms-test-access-key",
    secretAccessKey: "atoms-test-secret-key",
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });

  const upload = await provider.createUploadRequest({
    key: "quarantine/test.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    expiresInSeconds: 60,
  });
  const download = await provider.createDownloadRequest({
    key: "clean/test.txt",
    fileName: "test.txt",
    expiresInSeconds: 60,
  });

  assert.equal(new URL(upload.url).origin, "https://storage.staging.atoms.dev");
  assert.equal(
    new URL(upload.url).pathname,
    "/atoms-attachments/quarantine/test.txt",
  );
  assert.equal(new URL(download.url).origin, "https://storage.staging.atoms.dev");
  assert.equal(
    new URL(download.url).pathname,
    "/atoms-attachments/clean/test.txt",
  );
});

test("S3 presigned requests retain the private endpoint by default", async () => {
  const provider = new S3ObjectStorageProvider({
    bucket: "atoms-attachments",
    region: "us-east-1",
    endpoint: "http://minio:9000",
    forcePathStyle: true,
    accessKeyId: "atoms-test-access-key",
    secretAccessKey: "atoms-test-secret-key",
  });

  const upload = await provider.createUploadRequest({
    key: "quarantine/test.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    expiresInSeconds: 60,
  });

  assert.equal(new URL(upload.url).origin, "http://minio:9000");
});

class FakeTransport implements ClamAvTransport {
  readonly #reply: string;

  constructor(reply: string) {
    this.#reply = reply;
  }

  async scan(): Promise<string> {
    return this.#reply;
  }
}

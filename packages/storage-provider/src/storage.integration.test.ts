import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  calculateSha256,
  detectAttachmentMimeType,
} from "./content-inspection.js";
import { ClamAvScanner } from "./malware-scanner.js";
import { S3ObjectStorageProvider } from "./object-storage.js";

const integrationEnabled =
  process.env.RUN_STORAGE_INTEGRATION_TESTS === "true";

test(
  "MinIO and ClamAV validate the signed quarantine-to-clean lifecycle",
  {
    skip: integrationEnabled
      ? false
      : "requires explicit storage integration opt-in with disposable MinIO and ClamAV",
    timeout: 120_000,
  },
  async () => {
    assert.equal(
      process.env.STORAGE_INTEGRATION_CONFIRMATION,
      "DEDICATED_EPHEMERAL_STORAGE",
      "integration test requires explicitly disposable storage",
    );

    const provider = new S3ObjectStorageProvider({
      bucket: requireEnvironment("S3_BUCKET"),
      region: process.env.S3_REGION ?? "us-east-1",
      endpoint: requireEnvironment("S3_ENDPOINT"),
      forcePathStyle: true,
      accessKeyId: requireEnvironment("S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnvironment("S3_SECRET_ACCESS_KEY"),
      kmsKeyId: requireEnvironment("S3_KMS_KEY_ID"),
    });
    const scanner = new ClamAvScanner({
      host: process.env.CLAMAV_HOST ?? "127.0.0.1",
      port: Number(process.env.CLAMAV_PORT ?? "3310"),
      timeoutMs: 60_000,
    });
    const id = randomUUID();
    const quarantineKey = `integration/${id}/quarantine/source.txt`;
    const cleanBytes = new TextEncoder().encode(
      `secure attachment integration ${id}`,
    );
    const hash = calculateSha256(cleanBytes);
    const cleanKey = `integration/${id}/clean/${hash}`;

    try {
      const upload = await provider.createUploadRequest({
        key: quarantineKey,
        contentType: "text/plain",
        sizeBytes: cleanBytes.byteLength,
        expiresInSeconds: 60,
      });
      const preflight = await fetch(upload.url, {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "PUT",
          "access-control-request-headers": Object.keys(upload.headers).join(","),
        },
      });
      assert.ok([200, 204].includes(preflight.status));
      assert.equal(
        preflight.headers.get("access-control-allow-origin"),
        "http://localhost:3000",
      );

      const uploaded = await fetch(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body: Buffer.from(cleanBytes),
      });
      await assertResponseStatus(uploaded, 200);

      const metadata = await provider.headObject(quarantineKey);
      assert.ok(metadata);
      assert.equal(metadata.sizeBytes, cleanBytes.byteLength);
      assert.equal(metadata.contentType, "text/plain");

      const quarantined = await provider.getObject(
        quarantineKey,
        cleanBytes.byteLength,
      );
      assert.deepEqual(quarantined, cleanBytes);
      assert.equal(detectAttachmentMimeType(quarantined), "text/plain");
      assert.equal(calculateSha256(quarantined), hash);
      assert.deepEqual(await scanner.scan(quarantined), {
        clean: true,
        scanner: "clamav",
      });

      const eicar = new TextEncoder().encode(
        [
          "X5O!P%@AP[4\\PZX54(P^)7CC)7}$",
          "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!",
          "$H+H*",
        ].join(""),
      );
      const infected = await scanner.scan(eicar);
      assert.equal(infected.clean, false);
      if (infected.clean === false) assert.ok(infected.signature.length > 0);

      await provider.copyObject({
        sourceKey: quarantineKey,
        destinationKey: cleanKey,
        contentType: "text/plain",
      });
      await provider.deleteObject(quarantineKey);
      assert.equal(await provider.headObject(quarantineKey), null);

      const download = await provider.createDownloadRequest({
        key: cleanKey,
        fileName: "source.txt",
        expiresInSeconds: 60,
      });
      const downloaded = await fetch(download.url, { method: download.method });
      await assertResponseStatus(downloaded, 200);
      assert.deepEqual(
        new Uint8Array(await downloaded.arrayBuffer()),
        cleanBytes,
      );
    } finally {
      await provider.deleteObject(quarantineKey).catch(() => undefined);
      await provider.deleteObject(cleanKey).catch(() => undefined);
    }
  },
);

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function assertResponseStatus(
  response: Response,
  expectedStatus: number,
): Promise<void> {
  if (response.status === expectedStatus) return;
  assert.fail(
    `Expected HTTP ${String(expectedStatus)}, received ${String(response.status)}: ${await response.text()}`,
  );
}

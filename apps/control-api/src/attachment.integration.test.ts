import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { ATTACHMENT_SCAN_QUEUE_NAME } from "@atoms/contracts";
import { createPrismaClient } from "@atoms/db";
import { Queue } from "bullmq";

import { BullMqAttachmentScanQueue } from "./attachment-queue.js";
import { PrismaAttachmentRepository } from "./attachment-repository.js";
import { RepositoryAttachmentError } from "./errors.js";
import { PrismaControlRepository } from "./repository.js";

const integrationEnabled =
  process.env.RUN_ATTACHMENT_INTEGRATION_TESTS === "true";

test(
  "PostgreSQL and Redis enforce attachment quota, clean snapshots, and deterministic scan jobs",
  {
    skip: integrationEnabled
      ? false
      : "requires explicit attachment integration opt-in with dedicated PostgreSQL and Redis",
    timeout: 60_000,
  },
  async () => {
    assert.equal(
      process.env.ATTACHMENT_INTEGRATION_CONFIRMATION,
      "DEDICATED_EPHEMERAL_DATABASE",
      "integration test requires an explicitly dedicated ephemeral database",
    );
    const databaseUrl = requireEnvironment("DATABASE_URL");
    const redisUrl = requireEnvironment("REDIS_URL");
    const prisma = createPrismaClient(databaseUrl);
    const attachments = new PrismaAttachmentRepository(prisma);
    const control = new PrismaControlRepository(prisma);
    const workspaceId = randomUUID();
    const prefix = `atoms-attachments-${randomUUID().replaceAll("-", "")}`;
    const scanQueue = new BullMqAttachmentScanQueue({ redisUrl, prefix });
    const inspector = new Queue(ATTACHMENT_SCAN_QUEUE_NAME, {
      connection: { url: redisUrl, maxRetriesPerRequest: 1 },
      prefix,
    });

    try {
      await prisma.workspace.create({
        data: {
          id: workspaceId,
          name: "Attachment integration",
          slug: `attachment-${workspaceId.slice(0, 8)}`,
        },
      });
      const project = await control.createProject({
        workspaceId,
        name: "Clean snapshot",
        slug: "clean-snapshot",
      });
      const attachmentId = randomUUID();
      const created = await attachments.createAttachment({
        projectId: project.id,
        attachmentId,
        metadata: {
          fileName: "brief.pdf",
          contentType: "application/pdf",
          sizeBytes: 128,
        },
        uploadExpiresAt: new Date(Date.now() + 900_000),
      });
      assert.equal(created.kind, "ok");
      const quarantined = await attachments.completeUpload({
        projectId: project.id,
        attachmentId,
        etag: "etag-integration",
        now: new Date(),
      });
      assert.equal(quarantined.kind, "ok");
      await prisma.projectAttachment.update({
        where: { id: attachmentId },
        data: {
          status: "CLEAN",
          detectedContentType: "application/pdf",
          sha256: "a".repeat(64),
          cleanObjectKey: `tenants/${workspaceId}/projects/${project.id}/attachments/${attachmentId}/clean/${"a".repeat(64)}`,
          scannedAt: new Date(),
        },
      });

      const run = await control.createRun(project.id, "Build it", [attachmentId]);
      assert.ok(run);
      const snapshot = await prisma.agentRunAttachment.findUniqueOrThrow({
        where: {
          runId_attachmentId: { runId: run.id, attachmentId },
        },
      });
      assert.equal(snapshot.sha256, "a".repeat(64));
      assert.equal(snapshot.contentType, "application/pdf");

      const otherProject = await control.createProject({
        workspaceId,
        name: "Other project",
        slug: "other-project",
      });
      await assert.rejects(
        control.createRun(otherProject.id, "Cross tenant project input", [
          attachmentId,
        ]),
        RepositoryAttachmentError,
      );

      const quotaProject = await control.createProject({
        workspaceId,
        name: "Quota project",
        slug: "quota-project",
      });
      const quotaResults = await Promise.all(
        Array.from({ length: 6 }, async (_value, index) =>
          attachments.createAttachment({
            projectId: quotaProject.id,
            attachmentId: randomUUID(),
            metadata: {
              fileName: `reference-${String(index)}.txt`,
              contentType: "text/plain",
              sizeBytes: 10,
            },
            uploadExpiresAt: new Date(Date.now() + 900_000),
          }),
        ),
      );
      assert.equal(
        quotaResults.filter((result) => result.kind === "ok").length,
        5,
      );
      assert.equal(
        quotaResults.filter((result) => result.kind === "limit_reached").length,
        1,
      );

      const scanJob = { attachmentId, scanVersion: 1 } as const;
      await scanQueue.enqueue(scanJob);
      await scanQueue.enqueue(scanJob);
      const persistedJob = await inspector.getJob(`${attachmentId}-1`);
      assert.ok(persistedJob);
      assert.deepEqual(persistedJob.data, scanJob);
      assert.equal((await inspector.getJobs(["wait"], 0, -1)).length, 1);
    } finally {
      await inspector.obliterate({ force: true }).catch(() => undefined);
      await inspector.close();
      await scanQueue.close();
      await prisma.workspace
        .delete({ where: { id: workspaceId } })
        .catch(() => undefined);
      await prisma.$disconnect();
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

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Queue, Worker } from "bullmq";

import { assertQueuePrefix, createQueueConnection } from "./index.js";

// Needs a real multi-node Redis Cluster (CI starts three nodes). It reproduces the two
// failures that made every staging queue unusable on Azure Managed Redis (OSS cluster policy).
const clusterUrl = process.env.REDIS_CLUSTER_URL;
const enabled = process.env.RUN_QUEUE_CLUSTER_INTEGRATION_TESTS === "true" && Boolean(clusterUrl);
const skip = enabled ? false : "requires RUN_QUEUE_CLUSTER_INTEGRATION_TESTS=true and REDIS_CLUSTER_URL";

async function addJob(link: ReturnType<typeof createQueueConnection>, prefix: string): Promise<void> {
  const queue = new Queue("probe", { connection: link.connection, prefix });
  queue.on("error", () => undefined);
  try {
    await queue.add("probe", { at: Date.now() }, { removeOnComplete: true });
  } finally {
    await queue.close();
  }
}

test("a plain connection to a cluster fails with MOVED for some prefix (the second staging failure)", { skip }, async () => {
  assert.ok(clusterUrl);
  const outcomes: string[] = [];
  // Slots are spread over the nodes, so a plain connection is redirected for most prefixes.
  for (let index = 0; index < 12; index += 1) {
    const link = createQueueConnection({ redisUrl: clusterUrl, role: "queue", mode: "standalone" });
    try {
      await addJob(link, `{plain-${randomUUID()}}`);
      outcomes.push("ok");
    } catch (error) {
      outcomes.push(error instanceof Error ? error.message.split(" ")[0] ?? "error" : "error");
    } finally {
      await link.close();
    }
  }

  assert.ok(outcomes.includes("MOVED"), `expected a MOVED redirect, saw ${outcomes.join(",")}`);
});

test("a prefix without a hash tag fails with CROSSSLOT on a cluster connection (the first staging failure)", { skip }, async () => {
  assert.ok(clusterUrl);
  const link = createQueueConnection({ redisUrl: clusterUrl, role: "queue", mode: "oss-cluster" });
  try {
    await assert.rejects(addJob(link, `untagged-${randomUUID()}`), /CROSSSLOT/);
  } finally {
    await link.close();
  }
  // And the startup check refuses that prefix before it ever reaches Redis.
  assert.throws(() => assertQueuePrefix("oss-cluster", "untagged"), /hash tag/);
});

test("a cluster connection with a hash-tagged prefix adds a job and a worker processes it", { skip }, async () => {
  assert.ok(clusterUrl);
  const prefix = `{queue-it-${randomUUID()}}`;
  const queueLink = createQueueConnection({ redisUrl: clusterUrl, role: "queue", mode: "oss-cluster" });
  const workerLink = createQueueConnection({ redisUrl: clusterUrl, role: "worker", mode: "oss-cluster" });
  const queue = new Queue("run-probe", { connection: queueLink.connection, prefix });
  queue.on("error", () => undefined);
  let worker: Worker | undefined;
  try {
    const processed = new Promise<string>((resolve, reject) => {
      worker = new Worker(
        "run-probe",
        async (job) => {
          resolve(String(job.data.runId));
        },
        { connection: workerLink.connection, prefix, concurrency: 1 },
      );
      worker.on("error", () => undefined);
      worker.on("failed", (_job, error) => reject(error));
      setTimeout(() => reject(new Error("the job was not processed within 20s")), 20_000).unref();
    });

    await queue.add("execute-run", { runId: "run-1" }, { jobId: `run-1-start-${randomUUID()}` });

    assert.equal(await processed, "run-1");
  } finally {
    await worker?.close();
    await queue.close();
    await queueLink.close();
    await workerLink.close();
  }
});

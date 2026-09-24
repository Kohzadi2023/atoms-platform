import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { BullMqAttachmentScanQueue } from "./attachment-queue.js";
import { BullMqDatabaseOperationQueue } from "./database-operation-queue.js";
import { BullMqRunQueue } from "./run-queue.js";

const clusterWithoutTag = {
  redisUrl: "redis://127.0.0.1:1",
  redisMode: "oss-cluster",
} as const;

test("every queue refuses cluster mode without a hash-tagged prefix, before it opens a connection", () => {
  for (const create of [
    () => new BullMqRunQueue(clusterWithoutTag),
    () => new BullMqRunQueue({ ...clusterWithoutTag, prefix: "atoms-staging" }),
    () => new BullMqAttachmentScanQueue({ ...clusterWithoutTag, prefix: "atoms-staging" }),
    () => new BullMqDatabaseOperationQueue({ ...clusterWithoutTag, prefix: "atoms-staging" }),
  ]) {
    assert.throws(create, /hash tag/);
  }
});

test("the API passes the queue Redis mode to every queue and to the readiness source", async () => {
  const source = await readFile(resolve(process.cwd(), "src/main.ts"), "utf8");

  assert.match(source, /QUEUE_REDIS_MODE: QueueRedisModeSchema/u);
  const constructors = source.match(/new (BullMq\w+|RedisWorkerReadinessSource)\(\{/gu) ?? [];
  const passes = source.match(/redisMode: environment\.QUEUE_REDIS_MODE,/gu) ?? [];
  assert.equal(constructors.length, 4, "three queues and the readiness source");
  assert.equal(passes.length, constructors.length);
});

// Live-caught (2026-09-24): databaseQueue was the only one of the four not passing
// RUN_QUEUE_PREFIX, so assertQueuePrefix threw at startup ("requires a hash tag") the
// moment QUEUE_REDIS_MODE=oss-cluster was actually set on a live control-api -- the
// existing test above only checked redisMode, so this drifted unnoticed until then.
test("the API passes RUN_QUEUE_PREFIX to every queue and to the readiness source", async () => {
  const source = await readFile(resolve(process.cwd(), "src/main.ts"), "utf8");

  const prefixPasses = source.match(
    /\.\.\.\(environment\.RUN_QUEUE_PREFIX === undefined\s*\n\s*\? \{\}\s*\n\s*: \{ prefix: environment\.RUN_QUEUE_PREFIX \}\),/gu,
  ) ?? [];
  assert.equal(prefixPasses.length, 4, "three queues and the readiness source");
});

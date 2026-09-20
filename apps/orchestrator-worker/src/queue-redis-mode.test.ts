import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { BullMqDatabaseRecoveryQueue } from "./database-recovery-queue.js";

test("a queue refuses cluster mode without a hash-tagged prefix, before it opens a connection", () => {
  assert.throws(
    () => new BullMqDatabaseRecoveryQueue({ redisUrl: "redis://127.0.0.1:1", redisMode: "oss-cluster", prefix: "atoms-staging" }),
    /CROSSSLOT/,
  );
});

test("the worker passes the queue Redis mode to every BullMQ worker and queue and to the readiness client", async () => {
  const source = await readFile(resolve(process.cwd(), "src/main.ts"), "utf8");

  assert.match(source, /QUEUE_REDIS_MODE: QueueRedisModeSchema/u);
  const constructors = source.match(/new BullMq\w+\(\{/gu) ?? [];
  const passes = source.match(/redisMode: environment\.QUEUE_REDIS_MODE,/gu) ?? [];
  assert.equal(constructors.length, 6, "orchestrator, attachment, handoff, database, recovery, reconciliation");
  assert.equal(passes.length, constructors.length);
  assert.match(source, /createRedisClient\(\{\s*redisUrl: environment\.REDIS_URL,\s*mode: environment\.QUEUE_REDIS_MODE/u);
  // A plain client would fail with MOVED on a cluster.
  assert.doesNotMatch(source, /new Redis\(/u);
});

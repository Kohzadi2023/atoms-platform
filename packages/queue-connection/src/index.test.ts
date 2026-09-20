import assert from "node:assert/strict";
import test from "node:test";

import { Cluster, Redis } from "ioredis";

import {
  QueueRedisModeSchema,
  assertQueuePrefix,
  createQueueConnection,
  createRedisClient,
  queueClusterConfiguration,
} from "./index.js";

test("the mode defaults to standalone, so nothing changes unless it is set", () => {
  assert.equal(QueueRedisModeSchema.parse(undefined), "standalone");
  assert.equal(QueueRedisModeSchema.parse("oss-cluster"), "oss-cluster");
  assert.throws(() => QueueRedisModeSchema.parse("sentinel"));
});

test("standalone returns exactly the options the queues always used", async () => {
  const queue = createQueueConnection({ redisUrl: "redis://h:6379", role: "queue" });
  const worker = createQueueConnection({ redisUrl: "redis://h:6379", role: "worker", mode: "standalone" });

  assert.deepEqual(queue.connection, {
    url: "redis://h:6379",
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  assert.deepEqual(worker.connection, {
    url: "redis://h:6379",
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
  });
  await queue.close();
  await worker.close();
});

test("cluster configuration keeps TLS and credentials, and never leaks them in an error", () => {
  const configuration = queueClusterConfiguration(
    "rediss://user:p%40ss@cache.example.com:10000",
    "queue",
  );

  assert.deepEqual(configuration.nodes, [{ host: "cache.example.com", port: 10_000 }]);
  assert.equal(configuration.options.redisOptions?.username, "user");
  assert.equal(configuration.options.redisOptions?.password, "p@ss");
  assert.deepEqual(configuration.options.redisOptions?.tls, {
    rejectUnauthorized: true,
    servername: "cache.example.com",
  });

  assert.throws(
    () => queueClusterConfiguration("rediss://user:secret-value@host:99999", "queue"),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message === "Invalid queue Redis cluster configuration" &&
      !error.message.includes("secret-value"),
  );
  assert.throws(() => queueClusterConfiguration("http://host:6379", "queue"), TypeError);
  assert.throws(() => queueClusterConfiguration("redis://host:6379/3", "queue"), TypeError);
});

test("a worker's cluster connection never limits retries or times out blocking commands; a queue fails fast", () => {
  const worker = queueClusterConfiguration("redis://h:6379", "worker");
  const queue = queueClusterConfiguration("redis://h:6379", "queue");

  assert.equal(worker.options.redisOptions?.maxRetriesPerRequest, null);
  assert.equal(queue.options.redisOptions?.maxRetriesPerRequest, 1);
  // BullMQ workers block on BZPOPMIN; a command timeout would abort that wait.
  assert.equal("commandTimeout" in (worker.options.redisOptions ?? {}), false);
});

test("oss-cluster mode returns an ioredis Cluster that close() disconnects", async () => {
  const link = createQueueConnection({ redisUrl: "redis://127.0.0.1:1", role: "queue", mode: "oss-cluster" });
  assert.ok(link.connection instanceof Cluster);
  (link.connection as Cluster).on("error", () => undefined);

  await link.close();

  // disconnect() is asynchronous: the client is leaving, and no longer connecting or ready.
  assert.ok(["disconnecting", "end"].includes((link.connection as Cluster).status));
});

test("cluster mode requires a hash tag in the prefix, standalone accepts any", () => {
  assert.throws(() => assertQueuePrefix("oss-cluster", undefined), /hash tag/);
  assert.throws(() => assertQueuePrefix("oss-cluster", "atoms-staging"), /CROSSSLOT/);
  assert.throws(() => assertQueuePrefix("oss-cluster", "{}"), /hash tag/);
  assert.doesNotThrow(() => assertQueuePrefix("oss-cluster", "{atoms-staging}"));
  assert.doesNotThrow(() => assertQueuePrefix("oss-cluster", "prefix:{tag}:more"));

  assert.doesNotThrow(() => assertQueuePrefix("standalone", "atoms-staging"));
  assert.doesNotThrow(() => assertQueuePrefix(undefined, undefined));
});

test("createRedisClient follows the mode, and keeps the offline queue only when asked", async () => {
  const standalone = createRedisClient({ redisUrl: "redis://127.0.0.1:1", offlineQueue: true });
  const cluster = createRedisClient({ redisUrl: "redis://127.0.0.1:1", mode: "oss-cluster", offlineQueue: true });
  assert.ok(standalone instanceof Redis);
  assert.ok(cluster instanceof Cluster);
  assert.equal(standalone.options.enableOfflineQueue, true);
  assert.equal(cluster.options.enableOfflineQueue, true);
  for (const client of [standalone, cluster]) client.on("error", () => undefined);
  standalone.disconnect();
  cluster.disconnect();

  const strict = createRedisClient({ redisUrl: "redis://127.0.0.1:1", mode: "oss-cluster" });
  assert.equal((strict as Cluster).options.enableOfflineQueue, false);
  strict.on("error", () => undefined);
  strict.disconnect();
});

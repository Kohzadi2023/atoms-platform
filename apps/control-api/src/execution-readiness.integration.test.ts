import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { workerReadinessKey, type WorkerReadinessReport } from "@atoms/contracts";
import { Redis } from "ioredis";

import { RedisWorkerReadinessSource } from "./execution-readiness.js";

const redisUrl = process.env.REDIS_URL;
const enabled =
  process.env.RUN_READINESS_REDIS_INTEGRATION_TESTS === "true" &&
  typeof redisUrl === "string" &&
  redisUrl.length > 0;

const report: WorkerReadinessReport = {
  version: 1,
  publishedAt: new Date().toISOString(),
  runBudgetConfigured: true,
  workspaceCeilingConfigured: true,
  providerCredentialsPresent: true,
  egressVerified: false,
  attachmentContractVerified: true,
  browserViabilityRequired: true,
};

test(
  "the readiness report round-trips through real Redis under the queue prefix",
  { skip: enabled ? false : "requires RUN_READINESS_REDIS_INTEGRATION_TESTS=true and REDIS_URL" },
  async () => {
    assert.ok(redisUrl);
    const prefix = `readiness-test-${randomUUID()}`;
    const writer = new Redis(redisUrl);
    const source = new RedisWorkerReadinessSource({ redisUrl, prefix });
    try {
      assert.equal(await source.read(), null, "nothing published yet");

      // Exactly how the worker publishes: JSON with an expiry.
      await writer.set(workerReadinessKey(prefix), JSON.stringify(report), "EX", 180);
      assert.deepEqual(await source.read(), report);

      // A source that has just been created must wait for its connection, not read as
      // "no report": this is the first /readyz after the Control API starts.
      const cold = new RedisWorkerReadinessSource({ redisUrl, prefix });
      try {
        assert.deepEqual(await cold.read(), report, "first read on a cold connection");
      } finally {
        await cold.close();
      }

      await writer.set(workerReadinessKey(prefix), "{not json", "EX", 180);
      assert.equal(await source.read(), null, "garbage reads as no report");

      await writer.set(
        workerReadinessKey(prefix),
        JSON.stringify({ ...report, runBudgetConfigured: "yes" }),
        "EX",
        180,
      );
      assert.equal(await source.read(), null, "a schema-invalid report reads as no report");

      // Another queue prefix does not see this report.
      const other = new RedisWorkerReadinessSource({ redisUrl, prefix: `${prefix}-other` });
      try {
        assert.equal(await other.read(), null);
      } finally {
        await other.close();
      }
    } finally {
      await writer.del(workerReadinessKey(prefix));
      writer.disconnect();
      await source.close();
    }
  },
);

test(
  "an unreachable Redis reads as no report within the timeout instead of hanging",
  { skip: enabled ? false : "requires RUN_READINESS_REDIS_INTEGRATION_TESTS=true and REDIS_URL" },
  async () => {
    const source = new RedisWorkerReadinessSource({
      redisUrl: "redis://127.0.0.1:1",
      timeoutMs: 300,
    });
    try {
      const startedAt = Date.now();
      assert.equal(await source.read(), null);
      assert.ok(Date.now() - startedAt < 3_000);
    } finally {
      await source.close();
    }
  },
);

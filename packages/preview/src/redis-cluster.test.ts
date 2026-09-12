import assert from "node:assert/strict";
import test from "node:test";

import { PreviewRedisModeSchema, previewRedisClusterConfiguration } from "./index.js";

test("preview Redis mode is explicit, defaults to standalone, and rejects unknown policies", () => {
  assert.equal(PreviewRedisModeSchema.parse(undefined), "standalone");
  assert.equal(PreviewRedisModeSchema.parse("oss-cluster"), "oss-cluster");
  assert.throws(() => PreviewRedisModeSchema.parse("auto"));
});

test("cluster seed decodes ACL credentials and preserves TLS certificate verification/SNI", () => {
  const config = previewRedisClusterConfiguration("rediss://fixture%2Duser:fixture%40password@redis.example.test:10000/0");
  assert.deepEqual(config.nodes, [{ host: "redis.example.test", port: 10_000 }]);
  assert.equal(config.options.redisOptions?.username, "fixture-user");
  assert.equal(config.options.redisOptions?.password, "fixture@password");
  assert.deepEqual(config.options.redisOptions?.tls, { rejectUnauthorized: true, servername: "redis.example.test" });
  assert.equal(config.options.enableOfflineQueue, false);
  assert.equal(config.options.enableReadyCheck, true);
  assert.equal(config.options.maxRedirections, 8);
  assert.equal(config.options.redisOptions?.db, 0);
  assert.equal(config.options.redisOptions?.maxRetriesPerRequest, 1);
  assert.equal(config.options.redisOptions?.connectTimeout, 5_000);
  assert.equal(config.options.redisOptions?.commandTimeout, 5_000);
  config.options.dnsLookup?.("redis.example.test", (error, address) => {
    assert.equal(error, null);
    assert.equal(address, "redis.example.test");
  });
});

test("local cluster URI defaults to 6379 without inventing TLS or credentials", () => {
  const config = previewRedisClusterConfiguration("redis://redis-1/");
  assert.deepEqual(config.nodes, [{ host: "redis-1", port: 6_379 }]);
  assert.equal(config.options.redisOptions?.tls, undefined);
  assert.equal(config.options.redisOptions?.password, undefined);
  assert.equal(config.options.redisOptions?.username, undefined);
});

test("IPv6 cluster seeds retain the address without invalid brackets or IP SNI", () => {
  const config = previewRedisClusterConfiguration("rediss://[::1]:6380/0");
  assert.deepEqual(config.nodes, [{ host: "::1", port: 6_380 }]);
  assert.deepEqual(config.options.redisOptions?.tls, { rejectUnauthorized: true });
});

for (const url of [
  "not-a-url-fixture-password", "https://redis.example.test/", "redis://redis-1:0/0",
  "redis://redis-1/1", "redis://redis-1/0?tls=false", "redis://redis-1/0#fragment",
  "rediss://:%ZZ@redis.example.test:10000/0",
]) {
  test(`invalid cluster configuration fails with a credential-free fixed error (${url.startsWith("rediss") ? "malformed AUTH" : "URI shape"})`, () => {
    assert.throws(() => previewRedisClusterConfiguration(url), {
      name: "TypeError", message: "Invalid preview Redis cluster configuration",
    });
  });
}

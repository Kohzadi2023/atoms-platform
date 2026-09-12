import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { PreviewTicketSigner, RedisPreviewSessionStore } from "@atoms/preview";
import {
  REDIS_URL, SIGNING_SECRET, UPSTREAM_TOKEN, UI_ORIGIN, BASE_DOMAIN,
  GATEWAY_HOST, GATEWAY_PORT, UPSTREAM_URL,
} from "./fixture-config.mjs";

let stage = "opt-in";
const cases = [];
let seed;
let store;
const keys = new Set();
const deadline = setTimeout(() => {
  console.error("ATOMS_PREVIEW_RUNTIME_FAILED stage=deadline");
  process.exit(1);
}, 60_000);
deadline.unref();

function http(path, host, method = "GET", body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const call = request({
      hostname: GATEWAY_HOST, port: GATEWAY_PORT, path, method,
      headers: { host, ...extraHeaders }, timeout: 5_000,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks),
      }));
      response.on("error", reject);
    });
    call.on("error", reject);
    call.on("timeout", () => call.destroy(new Error("CI HTTP timeout")));
    call.end(body);
  });
}
async function diagnostics() {
  const response = await fetch(UPSTREAM_URL + "/__ci_diagnostics", { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  return response.json();
}
function websocket(path, host, expectedStatus) {
  return new Promise((resolve, reject) => {
    const sockets = [];
    const call = request({
      hostname: GATEWAY_HOST, port: GATEWAY_PORT, path,
      headers: {
        host, connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-version": "13", "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
      },
    });
    const timer = setTimeout(() => finish(new Error("CI WebSocket timeout")), 5_000);
    function finish(error) {
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      call.destroy();
      if (error) reject(error); else resolve();
    }
    call.on("error", finish);
    call.on("response", (response) => {
      response.resume();
      try { assert.equal(response.statusCode, expectedStatus); finish(); } catch (error) { finish(error); }
    });
    call.on("upgrade", (response, socket, head) => {
      sockets.push(socket);
      try {
        assert.equal(expectedStatus, 101);
        assert.equal(response.statusCode, 101);
      } catch (error) { finish(error); return; }
      // Verify byte forwarding after authenticated HTTP Upgrade, without a WS dependency.
      const frame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x6e ^ 1, 0x6b ^ 2]);
      let received = head;
      socket.on("error", finish);
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= frame.length) {
          try { assert.deepEqual(received, frame); finish(); } catch (error) { finish(error); }
        }
      });
      socket.write(frame);
    });
    call.end();
  });
}

async function smoke() {
  assert.equal(process.env.RUN_PREVIEW_RUNTIME_INTEGRATION_TESTS, "true");
  assert.equal(process.env.PREVIEW_RUNTIME_INTEGRATION_CONFIRMATION, "DEDICATED_EPHEMERAL_REDIS_CLUSTER");
  assert.equal(process.env.REDIS_URL, REDIS_URL);
  assert.equal(process.env.PREVIEW_BASE_DOMAIN, BASE_DOMAIN);
  assert.equal(process.env.RUN_EXECUTION_ENABLED, "false");
  for (const name of ["OPENAI_API_KEY", "E2B_API_KEY", "AZURE_CLIENT_SECRET"]) {
    assert.equal(process.env[name], undefined);
  }
  stage = "packaged-production-dependencies";
  assert.notEqual(process.getuid(), 0);
  assert.equal(existsSync("/app/src"), false);
  assert.equal(existsSync("/app/apps"), false);
  assert.equal(existsSync("/app/packages"), false);
  const require = createRequire(import.meta.url);
  for (const dependency of ["typescript", "tsx", "openai", "@atoms/model-gateway", "@atoms/sandbox-provider"]) {
    assert.throws(() => require.resolve(dependency), { code: "MODULE_NOT_FOUND" });
  }
  const { Redis } = createRequire(require.resolve("@atoms/preview"))("ioredis");
  cases.push(stage);

  stage = "exact-health";
  const health = await http("/healthz", "unsigned.preview.invalid");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, Buffer.from('{"status":"ok"}'));
  assert.equal(health.headers["cache-control"], "no-store");
  cases.push(stage);

  stage = "real-cluster-routing";
  seed = new Redis(REDIS_URL, {
    lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
    connectTimeout: 5_000, commandTimeout: 5_000,
  });
  await seed.connect();
  const slots = await seed.cluster("SLOTS");
  assert.equal(slots.length, 3);
  const seedId = await seed.cluster("MYID");
  const seedGroup = slots.findIndex(([, , master]) => master[2] === seedId);
  assert.notEqual(seedGroup, -1);
  const groups = new Map();
  for (let attempt = 0; attempt < 100 && groups.size < 3; attempt++) {
    const sessionId = randomUUID();
    const slot = await seed.cluster("KEYSLOT", "atoms:preview:" + sessionId);
    const group = slots.findIndex(([start, end]) => slot >= start && slot <= end);
    assert.notEqual(group, -1);
    if (!groups.has(group)) groups.set(group, sessionId);
  }
  assert.equal(groups.size, 3, "CI keys must span all three real shards");
  const signer = new PreviewTicketSigner({ secret: SIGNING_SECRET, baseDomain: BASE_DOMAIN, publicProtocol: "https" });
  store = new RedisPreviewSessionStore({ redisUrl: REDIS_URL, redisMode: "oss-cluster" });
  const targets = [];
  for (const sessionId of groups.values()) {
    keys.add(sessionId); // Include a possibly applied SET in cleanup before sending it.
    const target = {
      sessionId, workspaceId: randomUUID(), projectId: randomUUID(), runId: randomUUID(),
      upstreamUrl: UPSTREAM_URL, requestHeaders: { "x-ci-upstream-auth": UPSTREAM_TOKEN },
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
    // Offline queues remain disabled in production. Bound only initial readiness.
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await store.put(target); ready = true; break; } catch {
        if (attempt === 39) throw new Error("CI preview store did not become ready");
        await delay(100);
      }
    }
    assert.equal(ready, true);
    assert.deepEqual(await store.get(sessionId), target);
    const host = new URL(signer.issue(sessionId, new Date(target.expiresAt))).host;
    const response = await http("/fixture?q=private", host, "GET", undefined, { "x-ci-upstream-auth": "caller-spoof" });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body.toString()), {
      method: "GET", path: "/fixture?q=private", body: "", authenticated: true,
    });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-frame-options"], undefined);
    assert.ok(response.headers["content-security-policy"].includes("frame-ancestors " + UI_ORIGIN));
    assert.equal(response.headers["content-security-policy"].includes("frame-ancestors 'none'"), false);
    assert.equal(response.body.includes(Buffer.from(UPSTREAM_TOKEN)), false);
    targets.push({ target, host });
  }
  // Reproduce the original standalone-client defect independently of the fixed store.
  let moved = false;
  for (const { target } of targets) {
    try { await seed.get("atoms:preview:" + target.sessionId); } catch (error) {
      assert.match(error.message, /^MOVED \d+ /);
      moved = true;
    }
  }
  assert.equal(moved, true, "A standalone seed must fail for a non-seed shard");
  cases.push(stage);

  stage = "post-and-server-owned-auth";
  const post = await http("/submit?mode=private", targets[0].host, "POST", "private-fixture-body");
  assert.equal(post.status, 200);
  assert.deepEqual(JSON.parse(post.body.toString()), {
    method: "POST", path: "/submit?mode=private", body: "private-fixture-body", authenticated: true,
  });
  cases.push(stage);

  stage = "fail-closed-tickets-and-origins";
  const baseline = await diagnostics();
  const originalHost = targets[0].host;
  const label = originalHost.split(".")[0];
  const tampered = label.slice(0, -1) + (label.at(-1) === "0" ? "1" : "0") + ".preview.invalid";
  for (const host of ["unsigned.preview.invalid", tampered, originalHost.replace(".preview.invalid", ".elsewhere.invalid")]) {
    assert.equal((await http("/", host)).status, 401);
    await websocket("/", host, 401);
  }
  const expiredSigner = new PreviewTicketSigner({
    secret: SIGNING_SECRET, baseDomain: BASE_DOMAIN, now: () => new Date(Date.now() - 10_000),
  });
  const expiredHost = new URL(expiredSigner.issue(targets[0].target.sessionId, new Date(Date.now() - 5_000))).host;
  assert.equal((await http("/", expiredHost)).status, 410);
  const missingHost = new URL(signer.issue(randomUUID(), new Date(Date.now() + 60_000))).host;
  assert.equal((await http("/", missingHost)).status, 404);
  for (const path of ["http://mock-upstream:3101/", "//mock-upstream:3101/", "/\\mock-upstream:3101/"]) {
    assert.equal((await http(path, originalHost)).status, 400);
    await websocket(path, originalHost, 400);
  }
  assert.deepEqual(await diagnostics(), baseline, "Rejected requests must never contact either upstream");
  cases.push(stage);

  stage = "authenticated-websocket";
  await websocket("/hmr", originalHost, 101);
  const websocketCounts = await diagnostics();
  assert.equal(websocketCounts.websocket, baseline.websocket + 1);
  assert.equal(websocketCounts.rejectedAuth, 0);
  assert.equal(websocketCounts.wrongOrigin, 0);
  cases.push(stage);

  stage = "revocation-and-real-ttl";
  await store.delete(targets[0].target.sessionId);
  assert.equal(await store.get(targets[0].target.sessionId), null);
  assert.equal((await http("/", originalHost)).status, 404);
  const expiringId = groups.get(seedGroup);
  keys.add(expiringId);
  await store.put({ ...targets[1].target, sessionId: expiringId, expiresAt: new Date(Date.now() + 500).toISOString() });
  const expiringKey = "atoms:preview:" + expiringId;
  const serverTtl = await seed.pttl(expiringKey);
  assert.ok(serverTtl > 0 && serverTtl <= 500);
  assert.notEqual(await seed.get(expiringKey), null);
  assert.notEqual(await store.get(expiringId), null);
  await delay(650);
  assert.equal(await seed.get(expiringKey), null, "Redis itself must expire the PX key");
  assert.equal(await store.get(expiringId), null);
  cases.push(stage);
}

let failed = false;
try {
  await smoke();
} catch {
  failed = true;
  console.error("ATOMS_PREVIEW_RUNTIME_FAILED stage=" + stage);
} finally {
  let cleanupFailed = false;
  if (store) {
    for (const sessionId of keys) {
      try { await store.delete(sessionId); } catch { cleanupFailed = true; }
    }
    try { await store.close(); } catch { cleanupFailed = true; }
  }
  if (seed) {
    try { await seed.quit(); } catch { cleanupFailed = true; }
    seed.disconnect();
  }
  clearTimeout(deadline);
  if (cleanupFailed) {
    failed = true;
    console.error("ATOMS_PREVIEW_RUNTIME_FAILED stage=exact-fixture-cleanup");
  }
}
if (failed) process.exitCode = 1;
else console.log("ATOMS_PREVIEW_RUNTIME_OK " + JSON.stringify({
  cases, shards: 3, standaloneMovedReproduced: true,
  redisWrites: "EPHEMERAL_FIXTURE_ONLY", providerCalls: 0, publicIngress: false,
}));

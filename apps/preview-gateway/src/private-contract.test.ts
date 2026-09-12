import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import test, { type TestContext } from "node:test";

import {
  PreviewTicketSigner,
  RedisPreviewSessionStore,
  type PreviewTarget,
  type RedisPreviewClient,
} from "@atoms/preview";

import { buildPreviewGateway } from "./gateway.js";

// All credentials, records, and servers are local fixtures. Supplying the Redis
// client prevents RedisPreviewSessionStore from constructing a network client.
const SESSION_ID = "00000000-0000-4000-8000-000000000031";
const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000032";
const SECRET = "local-private-gateway-contract-signing-secret-only";
const FIXTURE_PROVIDER_TOKEN = "local-upstream-fixture-token";
const START = Date.parse("2026-09-12T00:00:00.000Z");

class LocalRedis implements RedisPreviewClient {
  readonly values = new Map<string, string>();
  readonly getKeys: string[] = [];
  readonly deletedKeys: string[] = [];
  lastTtl = 0;
  error: Error | undefined;

  async set(key: string, value: string, mode: "PX", ttl: number): Promise<void> {
    assert.equal(mode, "PX");
    this.lastTtl = ttl;
    this.values.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    this.getKeys.push(key);
    if (this.error !== undefined) throw this.error;
    return this.values.get(key) ?? null;
  }
  async del(key: string): Promise<void> {
    this.deletedKeys.push(key);
    this.values.delete(key);
  }
  async quit(): Promise<void> { throw new Error("must not close a caller-owned fixture client"); }
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening", { signal: AbortSignal.timeout(2_000) });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function forbiddenUpstream(context: TestContext) {
  let hits = 0;
  const server = createServer((_incoming, response) => {
    hits += 1;
    response.end("must not reach caller-selected upstream");
  });
  server.on("upgrade", (_incoming, socket) => {
    hits += 1;
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  context.after(async () => close(server));
  return { port: await listen(server), hitCount: () => hits };
}

async function fixture(context: TestContext) {
  let now = START;
  const observed: { url: string | undefined; method: string | undefined; headers: IncomingHttpHeaders; body: string }[] = [];
  let upgrades = 0;
  const upstream = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      observed.push({ url: incoming.url, method: incoming.method, headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors *" });
      response.end("<main>local private preview</main>");
    });
  });
  upstream.on("upgrade", (_incoming, socket) => {
    upgrades += 1;
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  context.after(async () => close(upstream));
  const upstreamPort = await listen(upstream);
  const redis = new LocalRedis();
  const store = new RedisPreviewSessionStore({ client: redis, now: () => new Date(now) });
  const signer = new PreviewTicketSigner({ secret: SECRET, baseDomain: "preview.invalid", now: () => new Date(now) });
  const target: PreviewTarget = {
    sessionId: SESSION_ID,
    workspaceId: "00000000-0000-4000-8000-000000000033",
    projectId: "00000000-0000-4000-8000-000000000034",
    runId: "00000000-0000-4000-8000-000000000035",
    upstreamUrl: `http://127.0.0.1:${String(upstreamPort)}`,
    requestHeaders: { "E2B-Traffic-Access-Token": FIXTURE_PROVIDER_TOKEN },
    expiresAt: new Date(START + 900_000).toISOString(),
  };
  const errors: unknown[] = [];
  const gateway = buildPreviewGateway({ signer, store, uiOrigin: "http://127.0.0.1:3000", onError: (error) => errors.push(error) });
  context.after(async () => { await close(gateway); await store.close(); });
  const port = await listen(gateway);
  const host = new URL(signer.issue(SESSION_ID, new Date(START + 900_000))).host;
  return { port, host, target, signer, store, redis, upstream, upstreamPort, observed, errors, upgradeCount: () => upgrades, advance: (milliseconds: number) => { now += milliseconds; } };
}

async function makeRequest(port: number, host: string, path = "/", headers: IncomingHttpHeaders = {}, body?: string) {
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: { ...headers, host } }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.setTimeout(2_000, () => outgoing.destroy(new Error("local contract request timed out")));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("private health is exact, no-store, and independent of tickets or session lookup", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  f.redis.error = new Error("fixture Redis unavailable");
  const result = await makeRequest(f.port, "private-gateway.invalid", "/healthz");
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"status":"ok"}');
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(f.redis.getKeys.length, 0);
  assert.equal(f.observed.length, 0);
});

test("signed private route uses the expiring Redis record and a loopback upstream", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  await f.store.put(f.target);
  const result = await makeRequest(f.port, f.host, "/dashboard?tab=local", { "e2b-traffic-access-token": "spoofed-fixture-token", "x-forwarded-host": "spoofed.invalid", "x-forwarded-proto": "http" });
  assert.equal(f.redis.lastTtl, 900_000);
  assert.deepEqual(f.redis.getKeys, [`atoms:preview:${SESSION_ID}`]);
  assert.equal(result.status, 200);
  assert.equal(result.body, "<main>local private preview</main>");
  assert.equal(f.observed.length, 1);
  assert.equal(f.observed[0]?.url, "/dashboard?tab=local");
  assert.equal(f.observed[0]?.headers.host, `127.0.0.1:${String(f.upstreamPort)}`);
  assert.equal(f.observed[0]?.headers["e2b-traffic-access-token"], FIXTURE_PROVIDER_TOKEN);
  assert.equal(f.observed[0]?.headers["x-forwarded-host"], f.host);
  assert.equal(f.observed[0]?.headers["x-forwarded-proto"], "https");
  assert.equal(result.headers["e2b-traffic-access-token"], undefined);
  assert.equal(result.body.includes(FIXTURE_PROVIDER_TOKEN), false);
  assert.equal(result.headers["x-frame-options"], undefined);
  assert.match(String(result.headers["content-security-policy"]), /frame-ancestors http:\/\/127\.0\.0\.1:3000/);
  assert.equal(result.headers["cache-control"], "no-store");
});

test("private route preserves POST body and query on its selected upstream", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  await f.store.put(f.target);
  const result = await makeRequest(f.port, f.host, "/submit?mode=local", { "content-type": "text/plain" }, "local body only");
  assert.equal(result.status, 200);
  assert.equal(f.observed[0]?.method, "POST");
  assert.equal(f.observed[0]?.url, "/submit?mode=local");
  assert.equal(f.observed[0]?.body, "local body only");
});

test("unsigned, tampered, and wrong-domain hosts cannot look up or reach a target", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  await f.store.put(f.target);
  const label = f.host.split(".")[0];
  assert.ok(label !== undefined);
  const tampered = `${label.slice(0, -1)}${label.at(-1) === "0" ? "1" : "0"}.preview.invalid`;
  for (const host of ["preview.invalid", "unsigned.preview.invalid", tampered, f.host.replace("preview.invalid", "elsewhere.invalid")]) {
    const result = await makeRequest(f.port, host, "/", { "x-forwarded-host": f.host });
    assert.equal(result.status, 401);
    assert.deepEqual(JSON.parse(result.body), { error: "Invalid preview URL" });
  }
  assert.equal(f.redis.getKeys.length, 0);
  assert.equal(f.observed.length, 0);
});

test("expired signed host returns 410 before a session lookup", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  await f.store.put(f.target);
  f.advance(900_000);
  const result = await makeRequest(f.port, f.host);
  assert.equal(result.status, 410);
  assert.deepEqual(JSON.parse(result.body), { error: "Preview expired" });
  assert.equal(f.redis.getKeys.length, 0);
  assert.equal(f.observed.length, 0);
});

test("valid ticket without a session returns 404 without contacting an upstream", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  const result = await makeRequest(f.port, f.host);
  assert.equal(result.status, 404);
  assert.deepEqual(JSON.parse(result.body), { error: "Preview not found" });
  assert.equal(f.observed.length, 0);
});

test("revoking the Redis session invalidates an otherwise valid signed URL", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  await f.store.put(f.target);
  await f.store.delete(SESSION_ID);
  const result = await makeRequest(f.port, f.host);
  assert.equal(result.status, 404);
  assert.equal(f.observed.length, 0);
});

test("expired Redis target is deleted even when the signed ticket is still valid", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  await f.store.put({ ...f.target, expiresAt: new Date(START + 1_000).toISOString() });
  f.advance(1_000);
  const result = await makeRequest(f.port, f.host);
  assert.equal(result.status, 404);
  assert.deepEqual(f.redis.deletedKeys, [`atoms:preview:${SESSION_ID}`]);
  assert.equal(f.observed.length, 0);
});

test("a mismatched Redis record cannot select another preview session", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  f.redis.values.set(`atoms:preview:${SESSION_ID}`, JSON.stringify({ ...f.target, sessionId: OTHER_SESSION_ID }));
  const result = await makeRequest(f.port, f.host);
  assert.equal(result.status, 404);
  assert.equal(f.observed.length, 0);
});

test("store errors fail closed without disclosing upstream metadata or fixture credentials", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  f.redis.error = new Error(`internal fixture error: ${f.target.upstreamUrl} ${FIXTURE_PROVIDER_TOKEN}`);
  const result = await makeRequest(f.port, f.host);
  assert.equal(result.status, 500);
  assert.deepEqual(JSON.parse(result.body), { error: "Preview gateway error" });
  assert.equal(f.observed.length, 0);
  assert.equal(f.errors.length, 1);
});

test("unavailable local upstream produces 502 without credential disclosure", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  await f.store.put(f.target);
  await close(f.upstream);
  const result = await makeRequest(f.port, f.host);
  assert.equal(result.status, 502);
  assert.deepEqual(JSON.parse(result.body), { error: "Preview upstream unavailable" });
  assert.equal(result.body.includes(FIXTURE_PROVIDER_TOKEN), false);
});

test("signed HTTP requests cannot override the selected upstream origin", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  const forbidden = await forbiddenUpstream(context);
  await f.store.put(f.target);
  for (const path of [`http://127.0.0.1:${String(forbidden.port)}/absolute`, `//127.0.0.1:${String(forbidden.port)}/authority`, `/\\127.0.0.1:${String(forbidden.port)}/backslash`]) {
    const result = await makeRequest(f.port, f.host, path);
    assert.equal(result.status, 400);
    assert.deepEqual(JSON.parse(result.body), { error: "Invalid preview request" });
  }
  assert.equal(forbidden.hitCount(), 0);
  assert.equal(f.observed.length, 0, "never forward credentials from a caller-controlled URL");
});

test("WebSocket ticket rejection happens before lookup and before upstream upgrade", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  await f.store.put(f.target);
  const headers = { connection: "Upgrade", upgrade: "websocket" };
  const unsigned = await makeRequest(f.port, "unsigned.preview.invalid", "/hmr", headers);
  assert.equal(unsigned.status, 401);
  f.advance(900_000);
  const expired = await makeRequest(f.port, f.host, "/hmr", headers);
  assert.equal(expired.status, 410);
  assert.equal(f.redis.getKeys.length, 0);
  assert.equal(f.upgradeCount(), 0);
});

test("signed WebSocket requests cannot override the selected upstream origin", { timeout: 5_000 }, async (context) => {
  const f = await fixture(context);
  const forbidden = await forbiddenUpstream(context);
  await f.store.put(f.target);
  for (const path of [
    `http://127.0.0.1:${String(forbidden.port)}/absolute-hmr`,
    `//127.0.0.1:${String(forbidden.port)}/authority-hmr`,
    `/\\127.0.0.1:${String(forbidden.port)}/backslash-hmr`,
  ]) {
    const result = await makeRequest(f.port, f.host, path, {
      connection: "Upgrade",
      upgrade: "websocket",
    });
    assert.equal(result.status, 400);
  }
  assert.equal(forbidden.hitCount(), 0);
  assert.equal(f.upgradeCount(), 0);
});

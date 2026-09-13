// Runs only inside the exact private Gateway replica. K is supplied by the
// nonce-bound carrier. Existing credentials and signed hosts never leave it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { randomBytes, randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

let phase = "PACKAGE", client, sessionId, owned = false, failure;
const servers = [], sockets = new Set();
const token = name => console.log(`ATOMS_PVNEG_${name}:${K.nonce}`);
const bounded = async (promise, milliseconds = 5000) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error()), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
};
let deadline = Infinity;

function requestGateway(host, path, upgrade = false) {
  assert.ok(Date.now() < deadline);
  return bounded(new Promise((resolve, reject) => {
    const headers = {
      host, connection: upgrade ? "Upgrade" : "close",
      "x-atoms-preview-smoke": "caller-spoof",
      "x-forwarded-host": "caller.invalid", "x-forwarded-proto": "http",
    };
    if (upgrade) Object.assign(headers, {
      upgrade: "websocket", "sec-websocket-version": "13",
      "sec-websocket-key": randomBytes(16).toString("base64"),
    });
    const request = http.request({ host: "127.0.0.1", port: K.port,
      method: "GET", path, headers, agent: false }, response => {
      let size = 0;
      const chunks = [];
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 2048) request.destroy(new Error());
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode,
        headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    // An unexpected accepted upgrade is a failure, never a hanging probe.
    request.on("upgrade", (_response, socket) => { socket.destroy(); reject(new Error()); });
    request.setTimeout(Math.min(4000, Math.max(1, deadline - Date.now())), () => request.destroy(new Error()));
    request.on("error", reject);
    request.end();
  }));
}

async function upstream(headerValue, expectedHost, positive) {
  const counts = { connections: 0, requests: 0, upgrades: 0 };
  const server = http.createServer((request, response) => {
    counts.requests++;
    const valid = positive && request.url === "/positive" &&
      request.headers["x-atoms-preview-smoke"] === headerValue &&
      request.headers["x-forwarded-host"] === expectedHost &&
      request.headers["x-forwarded-proto"] === "https";
    response.writeHead(valid ? 200 : 500);
    response.end(valid ? `POSITIVE:${K.nonce}` : "unexpected");
  });
  servers.push(server);
  server.on("connection", socket => {
    counts.connections++; sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  server.on("upgrade", (_request, socket) => {
    counts.upgrades++;
    socket.end("HTTP/1.1 500 Unexpected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await bounded(new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  }));
  return { port: server.address().port, counts };
}

(async () => {
  try {
    assert.notEqual(process.getuid(), 0);
    assert.equal(process.env.PREVIEW_REDIS_MODE, "oss-cluster");
    assert.equal(process.env.PREVIEW_BASE_DOMAIN, "preview.invalid");
    assert.equal(process.env.PREVIEW_PUBLIC_PROTOCOL, "https");
    assert.equal(fs.existsSync(K.file), false);
    token("PAYLOAD_CLEAN_OK");
    const previewPath = createRequire("/app/package.json").resolve("@atoms/preview");
    const preview = await import(pathToFileURL(previewPath).href);
    const { Cluster } = createRequire(previewPath)("ioredis");
    const config = preview.previewRedisClusterConfiguration(process.env.REDIS_URL);
    client = new Cluster(config.nodes, { ...config.options, lazyConnect: true });
    client.on("error", () => {});
    await bounded(client.connect(), 25000);
    const store = new preview.RedisPreviewSessionStore({ client, redisMode: "oss-cluster" });
    const signerOptions = { secret: process.env.PREVIEW_SIGNING_SECRET,
      baseDomain: "preview.invalid", publicProtocol: "https" };
    const signer = new preview.PreviewTicketSigner(signerOptions);
    token("PACKAGE_OK");

    phase = "FIXTURE";
    sessionId = randomUUID();
    const key = `atoms:preview:${sessionId}`;
    assert.equal(await bounded(client.get(key)), null);
    const expiresAt = new Date(Date.now() + 60000);
    const host = new URL(signer.issue(sessionId, expiresAt)).host;
    const header = randomBytes(16).toString("hex");
    const selected = await upstream(header, host, true);
    const decoy = await upstream("", "", false);
    owned = true; // SET may apply even if its reply is lost.
    await bounded(store.put({ sessionId, workspaceId: randomUUID(),
      projectId: randomUUID(), runId: randomUUID(),
      upstreamUrl: `http://127.0.0.1:${selected.port}`,
      requestHeaders: { "x-atoms-preview-smoke": header }, expiresAt: expiresAt.toISOString() }));
    const ttl = await bounded(client.pttl(key));
    assert.ok(ttl > 0 && ttl <= 60000);
    deadline = Date.now() + Math.min(35000, ttl - 5000);
    token("REDIS_WRITE_OK");

    phase = "POSITIVE";
    const positive = await requestGateway(host, "/positive");
    assert.equal(positive.status, 200);
    assert.equal(positive.body, `POSITIVE:${K.nonce}`);
    assert.equal(positive.headers["x-atoms-preview-smoke"], undefined);
    assert.deepEqual(selected.counts, { connections: 1, requests: 1, upgrades: 0 });
    token("POSITIVE_CONTROL_OK");
    const selectedBefore = { ...selected.counts };
    const checkIsolation = () => {
      assert.deepEqual(selected.counts, selectedBefore);
      assert.deepEqual(decoy.counts, { connections: 0, requests: 0, upgrades: 0 });
    };
    const reject = async (candidate, path, status, upgrade = false) => {
      const response = await requestGateway(candidate, path, upgrade);
      assert.equal(response.status, status);
      if (!upgrade) {
        const messages = { 401: "Invalid preview URL", 404: "Preview not found",
          410: "Preview expired", 400: "Invalid preview request" };
        assert.deepEqual(JSON.parse(response.body), { error: messages[status] });
        assert.equal(response.headers["cache-control"], "no-store");
      }
      assert.ok(!response.body.includes(header));
      checkIsolation();
    };
    const label = host.split(".")[0];
    const tampered = `${label.slice(0, -1)}${label.at(-1) === "0" ? "1" : "0"}.preview.invalid`;
    const oldSigner = new preview.PreviewTicketSigner({ ...signerOptions,
      now: () => new Date(Date.now() - 120000) });
    const expired = new URL(oldSigner.issue(sessionId, new Date(Date.now() - 60000))).host;
    const missingId = randomUUID();
    assert.equal(await bounded(client.get(`atoms:preview:${missingId}`)), null);
    const missing = new URL(signer.issue(missingId, expiresAt)).host;
    const invalid = [["unsigned.preview.invalid", 401], [tampered, 401],
      [host.replace("preview.invalid", "elsewhere.invalid"), 401], [expired, 410], [missing, 404]];
    for (const upgrade of [false, true]) {
      phase = upgrade ? "WS_REJECTION" : "HTTP_REJECTION";
      for (const [candidate, status] of invalid) await reject(candidate, "/denied", status, upgrade);
      token(upgrade ? "WS_REJECTION_OK" : "HTTP_REJECTION_OK");
    }

    const paths = [`http://127.0.0.1:${decoy.port}/absolute`,
      `//127.0.0.1:${decoy.port}/authority`, `/\\127.0.0.1:${decoy.port}/backslash`];
    for (const upgrade of [false, true]) {
      phase = upgrade ? "ORIGIN_WS" : "ORIGIN_HTTP";
      for (const path of paths) await reject(host, path, 400, upgrade);
      token(upgrade ? "ORIGIN_WS_OK" : "ORIGIN_HTTP_OK");
    }

    phase = "REVOKED";
    signer.verifyHost(host); // The ticket itself must still be valid.
    assert.ok(await bounded(client.pttl(key)) > 0);
    await bounded(store.delete(sessionId));
    assert.equal(await bounded(client.get(key)), null);
    await reject(host, "/revoked", 404);
    token("REVOKED_HTTP_OK");
    await reject(host, "/revoked", 404, true);
    token("REVOKED_WS_OK");
    checkIsolation();
    token("UPSTREAM_ISOLATION_OK");
  } catch { failure = phase; }
  finally {
    try {
      if (client && owned) {
        const key = `atoms:preview:${sessionId}`;
        await bounded(client.del(key));
        assert.equal(await bounded(client.get(key)), null);
      }
      token("REDIS_CLEANUP_OK");
    } catch { failure = "CLEANUP"; }
    try {
      for (const socket of sockets) socket.destroy();
      for (const server of servers) {
        server.closeAllConnections();
        if (server.listening) await bounded(new Promise(resolve => server.close(resolve)));
      }
      if (client) await bounded(client.quit());
      token("CLIENT_CLOSED_OK");
    } catch {
      client?.disconnect();
      if (failure !== "CLEANUP") failure = "CLOSE";
    }
    token(failure ? `FAILED_${failure}` : "REJECTION_OK");
    process.exitCode = failure ? 1 : 0;
  }
})();

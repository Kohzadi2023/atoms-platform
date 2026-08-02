import { once } from "node:events";
import { createServer, request } from "node:http";
import { createConnection } from "node:net";
import assert from "node:assert/strict";
import type { Duplex } from "node:stream";
import test from "node:test";

import {
  PreviewTicketSigner,
  type PreviewSessionStore,
  type PreviewTarget,
} from "@atoms/preview";

import { buildPreviewGateway } from "./gateway.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000021";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000022";
const PROJECT_ID = "00000000-0000-4000-8000-000000000023";
const RUN_ID = "00000000-0000-4000-8000-000000000024";
const NOW = new Date("2026-08-01T12:00:00.000Z");

class MemoryStore implements PreviewSessionStore {
  target: PreviewTarget | null = null;
  async put(target: PreviewTarget): Promise<void> {
    this.target = target;
  }
  async get(sessionId: string): Promise<PreviewTarget | null> {
    return this.target?.sessionId === sessionId ? this.target : null;
  }
  async delete(): Promise<void> {
    this.target = null;
  }
  async close(): Promise<void> {}
}

test("gateway validates the signed host, injects provider auth, and replaces iframe policy", async (context) => {
  let observedProviderToken: string | undefined;
  const upstream = createServer((incoming, response) => {
    observedProviderToken = incoming.headers["e2b-traffic-access-token"] as
      | string
      | undefined;
    response.writeHead(200, {
      "content-type": "text/html",
      "content-security-policy": "default-src *",
      "x-frame-options": "DENY",
    });
    response.end("<main>real preview</main>");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress !== null && typeof upstreamAddress === "object");

  const signer = new PreviewTicketSigner({
    secret: "phase-2-preview-gateway-secret-at-least-32-bytes",
    baseDomain: "preview.example.test",
    publicProtocol: "http",
    now: () => NOW,
  });
  const store = new MemoryStore();
  store.target = {
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    upstreamUrl: `http://127.0.0.1:${String(upstreamAddress.port)}`,
    requestHeaders: { "E2B-Traffic-Access-Token": "provider-secret" },
    expiresAt: "2026-08-01T12:15:00.000Z",
  };
  const gateway = buildPreviewGateway({
    signer,
    store,
    uiOrigin: "https://app.example.test",
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  context.after(() => gateway.close());
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress !== null && typeof gatewayAddress === "object");
  const previewUrl = new URL(
    signer.issue(SESSION_ID, new Date("2026-08-01T12:15:00.000Z")),
  );

  const result = await makeRequest(gatewayAddress.port, previewUrl.host, "/dashboard");

  assert.equal(result.statusCode, 200);
  assert.equal(result.body, "<main>real preview</main>");
  assert.equal(observedProviderToken, "provider-secret");
  assert.match(
    result.headers["content-security-policy"] as string,
    /frame-ancestors https:\/\/app\.example\.test/,
  );
  assert.equal(result.headers["x-frame-options"], undefined);
  assert.equal(result.headers["e2b-traffic-access-token"], undefined);
  assert.equal(result.headers["cache-control"], "no-store");
});

test("gateway rejects an unsigned preview hostname without contacting a target", async (context) => {
  const signer = new PreviewTicketSigner({
    secret: "phase-2-preview-gateway-secret-at-least-32-bytes",
    baseDomain: "preview.example.test",
    publicProtocol: "http",
    now: () => NOW,
  });
  const gateway = buildPreviewGateway({
    signer,
    store: new MemoryStore(),
    uiOrigin: "https://app.example.test",
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  context.after(() => gateway.close());
  const address = gateway.address();
  assert.ok(address !== null && typeof address === "object");

  const result = await makeRequest(
    address.port,
    "tampered.preview.example.test",
    "/",
  );

  assert.equal(result.statusCode, 401);
  assert.deepEqual(JSON.parse(result.body), { error: "Invalid preview URL" });
});

test("gateway carries authenticated WebSocket upgrades for preview HMR", async (context) => {
  let observedProviderToken: string | undefined;
  let upstreamUpgradeSocket: Duplex | undefined;
  const upstream = createServer();
  upstream.on("upgrade", (incoming, socket) => {
    upstreamUpgradeSocket = socket;
    observedProviderToken = incoming.headers["e2b-traffic-access-token"] as
      | string
      | undefined;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    socket.on("data", (data) => socket.write(data));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress !== null && typeof upstreamAddress === "object");

  const signer = new PreviewTicketSigner({
    secret: "phase-2-preview-gateway-secret-at-least-32-bytes",
    baseDomain: "preview.example.test",
    publicProtocol: "http",
    now: () => NOW,
  });
  const store = new MemoryStore();
  store.target = {
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    upstreamUrl: `http://127.0.0.1:${String(upstreamAddress.port)}`,
    requestHeaders: { "E2B-Traffic-Access-Token": "provider-secret" },
    expiresAt: "2026-08-01T12:15:00.000Z",
  };
  const gateway = buildPreviewGateway({
    signer,
    store,
    uiOrigin: "https://app.example.test",
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress !== null && typeof gatewayAddress === "object");
  const previewUrl = new URL(
    signer.issue(SESSION_ID, new Date("2026-08-01T12:15:00.000Z")),
  );
  const socket = createConnection({
    host: "127.0.0.1",
    port: gatewayAddress.port,
  });
  context.after(() => {
    socket.destroy();
    upstreamUpgradeSocket?.destroy();
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    gateway.close();
    upstream.close();
  });
  await once(socket, "connect", { signal: AbortSignal.timeout(2_000) });
  socket.write(
    `GET /_next/webpack-hmr HTTP/1.1\r\nHost: ${previewUrl.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
  );
  const handshake = await readUntil(socket, "\r\n\r\n");
  assert.match(handshake, /^HTTP\/1\.1 101/);

  socket.write("hmr-ping");
  const echoed = await readUntil(socket, "hmr-ping");

  assert.match(echoed, /hmr-ping/);
  assert.equal(observedProviderToken, "provider-secret");
});

async function makeRequest(
  port: number,
  host: string,
  path: string,
): Promise<{
  readonly statusCode: number | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { hostname: "127.0.0.1", port, path, headers: { host } },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            statusCode: incoming.statusCode,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function readUntil(socket: ReturnType<typeof createConnection>, marker: string): Promise<string> {
  let value = "";
  while (!value.includes(marker)) {
    const [chunk] = (await once(socket, "data", {
      signal: AbortSignal.timeout(2_000),
    })) as [Buffer];
    value += chunk.toString("utf8");
  }
  return value;
}

import assert from "node:assert/strict";
import fs from "node:fs";
import module from "node:module";
import net from "node:net";
import vm from "node:vm";
import { once } from "node:events";
import { pathToFileURL, fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const scriptPath = fileURLToPath(new URL("../atoms-staging-preview-gateway-private-live-session-smoke-v18.ps1", import.meta.url));
const payload = /\$LiveJavaScript = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(fs.readFileSync(scriptPath, "utf8"))?.[1];
assert.ok(payload, "Embedded v18 payload is required");
const bundle = fileURLToPath(new URL("../../apps/preview-gateway/", import.meta.url));
const appRequire = module.createRequire(`${bundle}/package.json`);
const previewPath = appRequire.resolve("@atoms/preview");
const preview = await import(pathToFileURL(previewPath).href);
const { buildPreviewGateway } = await import(pathToFileURL(`${bundle}/dist/gateway.js`).href);
const secret = "offline-only-signing-secret-012345678901234567890";
const redisUrl = "rediss://default:offline-only-password@fixture.canadacentral.redis.azure.net:10000/0";
let assertions = 0;
const check = (condition, label) => { assert.ok(condition, label); assertions += 1; };

async function closeServer(server) {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

for (const mode of ["success", "root", "redis-write-failed", "http-failed", "ws-failed", "cleanup-failed", "close-failed"]) {
  const records = new Map();
  const operations = [];
  const now = () => Date.now();
  const read = (key) => {
    const record = records.get(key);
    if (record === undefined) return null;
    if (record.expiresAt <= now()) { records.delete(key); return null; }
    return record.value;
  };
  class SharedClient {
    async set(key, value, redisMode, ttl) {
      operations.push("SET");
      assert.equal(redisMode, "PX");
      if (mode === "redis-write-failed") throw new Error("OFFLINE_SECRET_DO_NOT_PRINT");
      records.set(key, { value, expiresAt: now() + ttl });
      return "OK";
    }
    async get(key) { operations.push("GET"); return read(key); }
    async del(key) {
      operations.push("DEL");
      if (mode === "cleanup-failed") throw new Error("OFFLINE_SECRET_DO_NOT_PRINT");
      return records.delete(key) ? 1 : 0;
    }
    async pttl(key) {
      operations.push("PTTL");
      const record = records.get(key);
      if (record === undefined || read(key) === null) return -2;
      return Math.max(1, record.expiresAt - now());
    }
    async pexpire(key, ttl) {
      operations.push("PEXPIRE");
      const record = records.get(key);
      if (record === undefined || read(key) === null) return 0;
      record.expiresAt = now() + ttl;
      return 1;
    }
    async quit() {
      operations.push("QUIT");
      if (mode === "close-failed") throw new Error("OFFLINE_SECRET_DO_NOT_PRINT");
      return "OK";
    }
    disconnect() { operations.push("DISCONNECT"); }
  }
  class MockCluster extends SharedClient {
    constructor(nodes, options) {
      super();
      check(nodes.length === 1, `${mode}: production cluster seed used`);
      check(options.redisOptions.tls.rejectUnauthorized === true, `${mode}: TLS verification retained`);
    }
    on() { return this; }
    async connect() { operations.push("CONNECT"); }
  }

  const gatewayClient = new SharedClient();
  const gatewayStore = new preview.RedisPreviewSessionStore({ client: gatewayClient });
  const signer = new preview.PreviewTicketSigner({ secret, baseDomain: "preview.invalid", publicProtocol: "https" });
  const gatewayErrors = [];
  const gateway = buildPreviewGateway({ signer, store: gatewayStore, uiOrigin: "https://offline.invalid", onError: (error) => gatewayErrors.push(error) });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const gatewayPort = gateway.address().port;
  const unusedPort = await new Promise((resolve) => {
    const temporary = net.createServer();
    temporary.listen(0, "127.0.0.1", () => {
      const port = temporary.address().port;
      temporary.close(() => resolve(port));
    });
  });
  const nonce = "0123456789abcdef0123456789abcdef";
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atoms-offline-v18-"));
  const stageFile = path.join(stageRoot, "payload.b64");
  const output = [];
  const pendingTimers = new Set();
  const fakeProcess = {
    env: {
      REDIS_URL: redisUrl,
      PREVIEW_REDIS_MODE: "oss-cluster",
      PREVIEW_SIGNING_SECRET: secret,
      PREVIEW_BASE_DOMAIN: "preview.invalid",
      PREVIEW_PUBLIC_PROTOCOL: "https",
    },
    getuid: () => mode === "root" ? 0 : 1000,
    exitCode: 0,
  };
  const packageRequire = Object.assign(
    (name) => name === "ioredis" ? { Cluster: MockCluster } : appRequire(name),
    { resolve: (name) => appRequire.resolve(name) },
  );
  const mockModule = { ...module, createRequire: () => packageRequire };
  const mockNet = mode === "ws-failed"
    ? { ...net, connect: () => net.connect(unusedPort, "127.0.0.1") }
    : net;
  const mockRequire = (name) => {
    if (name === "node:module") return mockModule;
    if (name === "node:net") return mockNet;
    return appRequire(name);
  };
  const targetPort = mode === "http-failed" || mode === "cleanup-failed" ? unusedPort : gatewayPort;
  const source = `const K=${JSON.stringify({ nonce, port: targetPort, file: stageFile })};\n${payload}`;
  try {
    const completion = vm.runInNewContext(source, {
      require: mockRequire,
      process: fakeProcess,
      Buffer,
      URL,
      setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); pendingTimers.add(timer); return timer; },
      clearTimeout: timer => { pendingTimers.delete(timer); clearTimeout(timer); },
      console: { log: (line) => output.push(String(line)) },
    }, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    await Promise.race([
      completion,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`${mode}: payload exceeded 20 seconds`)), 20_000);
        timer.unref();
      }),
    ]);
    const text = output.join("\n");
    check(!text.includes(secret) && !text.includes("offline-only-password") && !text.includes("OFFLINE_SECRET_DO_NOT_PRINT"), `${mode}: no secret/error disclosure`);
    check(output.filter((line) => line === `ATOMS_PVE2E_REDIS_CLEANUP_OK:${nonce}`).length <= 1, `${mode}: no duplicate cleanup signal`);
    if (mode === "success") {
      const expected = ["PAYLOAD_CLEAN_OK", "PACKAGE_OK", "REDIS_WRITE_OK", "TTL_SET_OK", "HTTP_FORWARD_OK", "WS_FORWARD_OK", "TTL_EXPIRED_OK", "REDIS_CLEANUP_OK", "CLIENT_CLOSED_OK", "LIVE_OK"];
      check(fakeProcess.exitCode === 0, "success: zero remote exit");
      check(output.length === expected.length, "success: exact number of proof signals");
      for (const name of expected) check(output.includes(`ATOMS_PVE2E_${name}:${nonce}`), `success: ${name}`);
      check(records.size === 0, "success: temporary Redis key removed/expired");
      check(gatewayErrors.length === 0, "success: Gateway reported no internal error");
    } else {
      const expectedFailure = {
        root: "PACKAGE",
        "redis-write-failed": "REDIS_WRITE",
        "http-failed": "HTTP_FORWARD",
        "ws-failed": "WS_FORWARD",
        "cleanup-failed": "CLEANUP",
        "close-failed": "CLOSE",
      }[mode];
      check(fakeProcess.exitCode === 1, `${mode}: nonzero remote exit`);
      check(output.includes(`ATOMS_PVE2E_FAILED_${expectedFailure}:${nonce}`), `${mode}: fixed failure phase`);
      check(!output.some((line) => line.includes("LIVE_OK")), `${mode}: no false success`);
      if (mode === "cleanup-failed") {
        const remaining = [...records.values()];
        check(remaining.length === 1 && remaining[0].expiresAt - now() <= 60_000, "cleanup-failed: ambiguous key remains TTL-bounded");
      } else {
        check(records.size === 0, `${mode}: temporary Redis key absent after failure`);
      }
    }
    check(operations.every((name) => ["CONNECT", "SET", "GET", "DEL", "PTTL", "PEXPIRE", "QUIT", "DISCONNECT"].includes(name)), `${mode}: only bounded Redis operations used`);
  } finally {
    for (const timer of pendingTimers) clearTimeout(timer);
    records.clear();
    await closeServer(gateway);
    await gatewayStore.close();
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

console.log(`V18 PRIVATE LIVE-SESSION PAYLOAD TESTS PASSED: ${assertions} assertions; HTTP/WebSocket/TTL/cleanup paths are local only.`);

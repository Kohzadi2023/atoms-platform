import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import module from "node:module";
import vm from "node:vm";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const artifact = new URL("../atoms-staging-preview-gateway-private-rejection-smoke-v19.ps1", import.meta.url);
const embedded = /\$LiveJavaScript = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(fs.readFileSync(artifact, "utf8"))?.[1];
assert.ok(embedded);
assert.equal(embedded.replaceAll("\r\n", "\n").trimEnd(),
  fs.readFileSync(new URL("./v19-rejection.cjs", import.meta.url), "utf8").replaceAll("\r\n", "\n").trimEnd(),
  "Delivered script must contain exactly the reviewed readable payload");
const appDirectory = fileURLToPath(new URL("../../apps/preview-gateway/", import.meta.url));
const appRequire = module.createRequire(`${appDirectory}/package.json`);
const previewPath = appRequire.resolve("@atoms/preview");
const preview = await import(pathToFileURL(previewPath).href);
const { buildPreviewGateway } = await import(pathToFileURL(`${appDirectory}/dist/gateway.js`).href);
const secret = "local-only-rejection-probe-signing-secret-012345678901";
const nonce = "0123456789abcdef0123456789abcdef";
const successNames = ["PAYLOAD_CLEAN_OK", "PACKAGE_OK", "REDIS_WRITE_OK", "POSITIVE_CONTROL_OK",
  "HTTP_REJECTION_OK", "WS_REJECTION_OK", "ORIGIN_HTTP_OK", "ORIGIN_WS_OK",
  "REVOKED_HTTP_OK", "REVOKED_WS_OK", "UPSTREAM_ISOLATION_OK", "REDIS_CLEANUP_OK",
  "CLIENT_CLOSED_OK", "REJECTION_OK"];
const modes = ["success", "root", "write-failed", "positive-failed", "http-rejection-failed",
  "ws-rejection-failed", "origin-http-failed", "origin-ws-failed", "revoked-failed",
  "upstream-contact", "cleanup-failed", "close-failed"];
let assertions = 0;
const check = (value, label) => { assert.ok(value, label); assertions++; };

for (const mode of modes) {
  const records = new Map(), written = new Set(), operations = [], timers = new Set();
  let target, attemptedExtraContact = false;
  const read = key => {
    const record = records.get(key);
    if (!record) return null;
    if (record.expires <= Date.now()) { records.delete(key); return null; }
    return record.value;
  };
  class FixtureClient {
    async set(key, value, ttlMode, ttl) {
      operations.push("SET"); assert.equal(ttlMode, "PX");
      check(ttl > 0 && ttl <= 60000, `${mode}: maximum TTL retained`);
      if (mode === "write-failed") throw new Error("OFFLINE_SECRET_DO_NOT_PRINT");
      written.add(key); target = JSON.parse(value);
      records.set(key, { value, expires: Date.now() + ttl }); return "OK";
    }
    async get(key) { operations.push("GET"); return read(key); }
    async pttl(key) { operations.push("PTTL"); return read(key) === null ? -2 : records.get(key).expires - Date.now(); }
    async del(key) {
      operations.push("DEL");
      if (mode === "cleanup-failed") throw new Error("OFFLINE_SECRET_DO_NOT_PRINT");
      return Number(records.delete(key));
    }
    async quit() {
      operations.push("QUIT");
      if (mode === "close-failed") throw new Error("OFFLINE_SECRET_DO_NOT_PRINT");
    }
    disconnect() { operations.push("DISCONNECT"); }
  }
  class MockCluster extends FixtureClient {
    constructor(nodes, options) {
      super();
      check(nodes.length === 1 && options.redisOptions.tls.rejectUnauthorized === true, `${mode}: production TLS cluster config`);
    }
    on() { return this; }
    async connect() { operations.push("CONNECT"); }
  }
  const gatewayStore = new preview.RedisPreviewSessionStore({ client: new FixtureClient(), redisMode: "oss-cluster" });
  const gatewayErrors = [];
  const gateway = buildPreviewGateway({ store: gatewayStore,
    signer: new preview.PreviewTicketSigner({ secret, baseDomain: "preview.invalid", publicProtocol: "https" }),
    uiOrigin: "https://offline.invalid", onError: error => gatewayErrors.push(error) });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const port = gateway.address().port;
  const packageRequire = Object.assign(name => name === "ioredis" ? { Cluster: MockCluster } : appRequire(name),
    { resolve: name => appRequire.resolve(name) });
  const testHttp = { ...http,
    request(options, callback) {
      assert.equal(options.host, "127.0.0.1"); assert.equal(options.port, port);
      const isUpgrade = options.headers.upgrade === "websocket";
      return http.request(options, response => {
        const corrupt =
          ((mode === "positive-failed" || mode === "cleanup-failed") && options.path === "/positive") ||
          (mode === "http-rejection-failed" && options.path === "/denied" && !isUpgrade) ||
          (mode === "ws-rejection-failed" && options.path === "/denied" && isUpgrade) ||
          (mode === "origin-http-failed" && options.path.startsWith("http:") && !isUpgrade) ||
          (mode === "origin-ws-failed" && options.path.startsWith("http:") && isUpgrade) ||
          (mode === "revoked-failed" && options.path === "/revoked");
        if (corrupt) response.statusCode = response.statusCode === 200 ? 502 : 200;
        if (mode === "upstream-contact" && options.path === "/denied" && !attemptedExtraContact) {
          attemptedExtraContact = true;
          const destination = new URL(target.upstreamUrl);
          assert.equal(destination.hostname, "127.0.0.1");
          // Retain the correct rejection but simulate an erroneous extra
          // upstream contact; only the isolation assertion can detect it.
          const extra = http.get(destination, upstreamResponse => {
            upstreamResponse.resume();
            upstreamResponse.on("end", () => callback(response));
          });
          extra.on("error", error => response.destroy(error));
        } else callback(response);
      });
    },
  };
  const processFixture = { getuid: () => mode === "root" ? 0 : 1000, exitCode: 0, env: {
    PREVIEW_REDIS_MODE: "oss-cluster", PREVIEW_BASE_DOMAIN: "preview.invalid",
    PREVIEW_PUBLIC_PROTOCOL: "https", PREVIEW_SIGNING_SECRET: secret,
    REDIS_URL: "rediss://default:offline-password@fixture.canadacentral.redis.azure.net:10000/0",
  } };
  const output = [];
  const source = `const K=${JSON.stringify({ nonce, port, file: "/offline-owned-absent-file" })};\n${embedded}`;
  try {
    const completion = vm.runInNewContext(source, {
      process: processFixture, Buffer, URL,
      require: name => {
        if (name === "node:module") return { ...module, createRequire: () => packageRequire };
        if (name === "node:http") return testHttp;
        if (name === "node:fs") return { existsSync: () => false };
        return appRequire(name);
      },
      setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
      clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
      console: { log: line => output.push(String(line)) },
    }, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    let guard;
    try {
      await Promise.race([completion, new Promise((_, reject) => {
        guard = setTimeout(() => reject(new Error(`${mode}: offline timeout`)), 15000);
      })]);
    } finally { clearTimeout(guard); }
    const text = output.join("\n");
    check(!text.includes(secret) && !text.includes("offline-password") && !text.includes("OFFLINE_SECRET_DO_NOT_PRINT"), `${mode}: no secret/error disclosure`);
    check(written.size <= 1, `${mode}: at most one fixture key was written`);
    check([...written].every(key => /^atoms:preview:[a-f0-9-]{36}$/u.test(key)), `${mode}: generated preview keys only`);
    check(operations.every(op => ["SET", "GET", "PTTL", "DEL", "QUIT", "DISCONNECT", "CONNECT"].includes(op)), `${mode}: bounded commands only`);
    if (mode === "success") {
      check(processFixture.exitCode === 0, "success: zero remote exit");
      assert.deepEqual(output, successNames.map(name => `ATOMS_PVNEG_${name}:${nonce}`));
      assertions += successNames.length;
      check(written.size === 1 && operations.filter(op => op === "SET").length === 1, "success: one fixture SET");
      check(gatewayErrors.length === 0, "success: no internal Gateway errors");
    } else {
      const phase = { root: "PACKAGE", "write-failed": "FIXTURE", "positive-failed": "POSITIVE",
        "http-rejection-failed": "HTTP_REJECTION", "ws-rejection-failed": "WS_REJECTION",
        "origin-http-failed": "ORIGIN_HTTP", "origin-ws-failed": "ORIGIN_WS", "revoked-failed": "REVOKED",
        "upstream-contact": "HTTP_REJECTION", "cleanup-failed": "CLEANUP", "close-failed": "CLOSE" }[mode];
      check(processFixture.exitCode === 1, `${mode}: nonzero remote exit`);
      check(output.includes(`ATOMS_PVNEG_FAILED_${phase}:${nonce}`), `${mode}: exact fixed failure phase`);
      check(!output.includes(`ATOMS_PVNEG_REJECTION_OK:${nonce}`), `${mode}: no false success`);
    }
    if (mode === "cleanup-failed") {
      check(records.size === 1 && [...records.values()][0].expires - Date.now() <= 60000, "cleanup failure remains TTL-bounded");
    } else check(records.size === 0, `${mode}: fixture absent after cleanup`);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    gateway.closeAllConnections();
    if (gateway.listening) await new Promise(resolve => gateway.close(resolve));
    await gatewayStore.close(); records.clear();
  }
}
console.log(`V19 OFFLINE REJECTION PAYLOAD PASSED: ${assertions} assertions; ${modes.length} local success/failure modes. No Azure or live Redis request was made.`);

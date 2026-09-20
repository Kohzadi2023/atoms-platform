import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_HOST,
  DEFAULT_MIN_DAYS,
  daysUntil,
  evaluateCertificate,
  fetchCertificate,
  parseArguments,
  run,
} from "./check-preview-cert-expiry.mjs";

const NOW = new Date("2026-09-19T12:00:00.000Z");

function certificate(daysLeft, extra = {}) {
  return {
    subject: "*.preview.genesisco.io",
    issuer: "Let's Encrypt",
    validTo: new Date(NOW.getTime() + daysLeft * 86_400_000).toUTCString(),
    ...extra,
  };
}

test("days left are whole days, rounded down, and negative once expired", () => {
  assert.equal(daysUntil(certificate(90).validTo, NOW), 90);
  assert.equal(daysUntil(new Date(NOW.getTime() + 89.9 * 86_400_000).toUTCString(), NOW), 89);
  assert.equal(daysUntil(certificate(-1).validTo, NOW), -1);
  assert.throws(() => daysUntil("not a date", NOW), /unreadable/);
});

test("plenty of validity is OK; under the threshold says to renew; expired says so", () => {
  const ok = evaluateCertificate(certificate(60), { minDays: 30, now: NOW });
  assert.equal(ok.code, 0);
  assert.ok(ok.lines.some((line) => line.startsWith("OK")));

  const soon = evaluateCertificate(certificate(29), { minDays: 30, now: NOW });
  assert.equal(soon.code, 1);
  assert.ok(soon.lines.some((line) => line.includes("RENEW NOW")));

  const boundary = evaluateCertificate(certificate(30), { minDays: 30, now: NOW });
  assert.equal(boundary.code, 0);

  const expired = evaluateCertificate(certificate(-2), { minDays: 30, now: NOW });
  assert.equal(expired.code, 1);
  assert.ok(expired.lines.some((line) => line.startsWith("EXPIRED")));
});

test("a certificate that is not trusted for the host fails even with time left", () => {
  const result = evaluateCertificate(
    certificate(80, { authorizationError: "ERR_TLS_CERT_ALTNAME_INVALID" }),
    { minDays: 30, now: NOW },
  );

  assert.equal(result.code, 1);
  assert.ok(result.lines.some((line) => line.includes("NOT TRUSTED")));
});

test("arguments: defaults, a hostname is required to look like one, days are bounded", () => {
  assert.deepEqual(
    { host: parseArguments([]).host, minDays: parseArguments([]).minDays },
    { host: DEFAULT_HOST, minDays: DEFAULT_MIN_DAYS },
  );
  assert.equal(parseArguments(["--host", "a.preview.genesisco.io", "--min-days", "14"]).minDays, 14);
  assert.throws(() => parseArguments(["--host", "not a host"]), /hostname/);
  assert.throws(() => parseArguments(["--host", "https://x.example.com"]), /hostname/);
  assert.throws(() => parseArguments(["--min-days", "0"]), /1 to 365/);
  assert.throws(() => parseArguments(["--min-days", "abc"]), /1 to 365/);
  assert.throws(() => parseArguments(["--frobnicate"]), /unknown argument/);
});

test("run returns 0, 1 or 2 and prints what it found", async () => {
  const output = [];
  const write = (line) => output.push(line);

  assert.equal(await run([], { fetchCertificateImpl: async () => certificate(80), now: () => NOW, write }), 0);
  assert.equal(await run([], { fetchCertificateImpl: async () => certificate(5), now: () => NOW, write }), 1);
  assert.equal(
    await run([], {
      fetchCertificateImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      now: () => NOW,
      write,
    }),
    2,
  );
  assert.equal(await run(["--host", "nope"], { write }), 2);
  assert.equal(
    await run([], { fetchCertificateImpl: async () => certificate(80, { validTo: "garbage" }), now: () => NOW, write }),
    2,
  );
  assert.ok(output.some((line) => line.includes(`Host:    ${DEFAULT_HOST}`)));
});

test("fetchCertificate reads the presented certificate and sends nothing", async () => {
  const writes = [];
  const socket = new EventEmitter();
  socket.setTimeout = () => undefined;
  socket.authorized = false;
  socket.authorizationError = "CERT_HAS_EXPIRED";
  socket.write = (data) => writes.push(data);
  socket.end = () => undefined;
  socket.destroy = () => undefined;
  socket.getPeerCertificate = () => ({
    valid_to: "Dec 18 12:00:00 2026 GMT",
    subject: { CN: "*.preview.genesisco.io" },
    issuer: { O: "Let's Encrypt" },
  });
  let options;

  const promise = fetchCertificate("x.preview.genesisco.io", 1_000, (received) => {
    options = received;
    queueMicrotask(() => socket.emit("secureConnect"));
    return socket;
  });
  const result = await promise;

  assert.equal(options.servername, "x.preview.genesisco.io");
  assert.equal(options.port, 443);
  assert.equal(result.validTo, "Dec 18 12:00:00 2026 GMT");
  assert.equal(result.authorizationError, "CERT_HAS_EXPIRED");
  assert.deepEqual(writes, [], "no request is sent over the connection");
});

test("fetchCertificate rejects on a connection error and when no certificate is presented", async () => {
  const failing = new EventEmitter();
  failing.setTimeout = () => undefined;
  failing.destroy = () => undefined;
  const failed = fetchCertificate("x.example.com", 1_000, () => {
    queueMicrotask(() => failing.emit("error", new Error("ECONNRESET")));
    return failing;
  });
  await assert.rejects(failed, /ECONNRESET/);

  const empty = new EventEmitter();
  empty.setTimeout = () => undefined;
  empty.authorized = true;
  empty.end = () => undefined;
  empty.getPeerCertificate = () => ({});
  const none = fetchCertificate("x.example.com", 1_000, () => {
    queueMicrotask(() => empty.emit("secureConnect"));
    return empty;
  });
  await assert.rejects(none, /no certificate/);
});

test("the script is read-only: it opens a connection and never writes to it or shells out", async () => {
  const source = await readFile(new URL("./check-preview-cert-expiry.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /socket\.write|child_process|exec\(|spawn\(/u);
  assert.match(source, /rejectUnauthorized: false/u);
});

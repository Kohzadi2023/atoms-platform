import assert from "node:assert/strict";
import test from "node:test";

import {
  PreviewTicketError,
  PreviewTicketSigner,
  RedisPreviewSessionStore,
  type RedisPreviewClient,
} from "./index.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000011";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000012";
const PROJECT_ID = "00000000-0000-4000-8000-000000000013";
const RUN_ID = "00000000-0000-4000-8000-000000000014";
const NOW = new Date("2026-08-01T12:00:00.000Z");
const SECRET = "phase-2-preview-signing-secret-at-least-32-bytes";

test("preview tickets use one DNS-safe signed label and reject tampering", () => {
  const signer = new PreviewTicketSigner({
    secret: SECRET,
    baseDomain: "preview.example.test",
    now: () => NOW,
  });
  const url = new URL(
    signer.issue(SESSION_ID, new Date("2026-08-01T12:15:00.000Z")),
  );

  assert.deepEqual(signer.verifyHost(url.host), {
    sessionId: SESSION_ID,
    expiresAt: "2026-08-01T12:15:00.000Z",
  });

  const baseLabels = "preview.example.test".split(".");
  const labels = url.hostname.split(".");
  assert.equal(labels.length, baseLabels.length + 1);
  const ticketLabel = labels[0];
  assert.ok(ticketLabel !== undefined);
  assert.equal(ticketLabel.length, 61);
  assert.match(ticketLabel, /^[a-z0-9]{25}-[a-z0-9]{9}-[a-z0-9]{25}$/);

  const tamperedCharacter = ticketLabel.at(-1) === "0" ? "1" : "0";
  const tamperedLabel = `${ticketLabel.slice(0, -1)}${tamperedCharacter}`;
  assert.throws(
    () => signer.verifyHost(`${tamperedLabel}.preview.example.test`),
    (error: unknown) =>
      error instanceof PreviewTicketError &&
      error.code === "INVALID_SIGNATURE",
  );
});

test("preview tickets reject extra dynamic DNS labels", () => {
  const signer = new PreviewTicketSigner({
    secret: SECRET,
    baseDomain: "preview.example.test",
    now: () => NOW,
  });
  const url = new URL(
    signer.issue(SESSION_ID, new Date("2026-08-01T12:15:00.000Z")),
  );

  assert.throws(
    () => signer.verifyHost(`extra.${url.host}`),
    (error: unknown) =>
      error instanceof PreviewTicketError && error.code === "INVALID_HOST",
  );
});

test("preview tickets expire deterministically", () => {
  const issuer = new PreviewTicketSigner({
    secret: SECRET,
    baseDomain: "preview.example.test",
    now: () => NOW,
  });
  const url = new URL(
    issuer.issue(SESSION_ID, new Date("2026-08-01T12:01:00.000Z")),
  );
  const verifier = new PreviewTicketSigner({
    secret: SECRET,
    baseDomain: "preview.example.test",
    now: () => new Date("2026-08-01T12:01:00.001Z"),
  });

  assert.throws(
    () => verifier.verifyHost(url.host),
    (error: unknown) =>
      error instanceof PreviewTicketError && error.code === "EXPIRED_TICKET",
  );
});

class FakeRedis implements RedisPreviewClient {
  readonly values = new Map<string, string>();
  lastTtl = 0;
  quitCalled = false;

  async set(
    key: string,
    value: string,
    _mode: "PX",
    milliseconds: number,
  ): Promise<void> {
    this.values.set(key, value);
    this.lastTtl = milliseconds;
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async quit(): Promise<void> {
    this.quitCalled = true;
  }
}

test("Redis store keeps provider credentials only in an expiring target record", async () => {
  const redis = new FakeRedis();
  const store = new RedisPreviewSessionStore({
    client: redis,
    now: () => NOW,
  });
  const target = {
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    upstreamUrl: "https://3000-sandbox.e2b.app",
    requestHeaders: { "E2B-Traffic-Access-Token": "provider-secret" },
    expiresAt: "2026-08-01T12:15:00.000Z",
  } as const;

  await store.put(target);

  assert.equal(redis.lastTtl, 900_000);
  assert.deepEqual(await store.get(SESSION_ID), target);
  await store.delete(SESSION_ID);
  assert.equal(await store.get(SESSION_ID), null);
  await store.close();
  assert.equal(redis.quitCalled, false);
});

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LIVE_PROVIDER_CONFIRMATION,
  SMOKE_CONFIRMATION,
  assertRedactedEvidence,
  executeAuthenticatedStagingSmoke,
  validateSmokeCommandOptions,
  writeRedactedEvidence,
} from "./smoke-staging-authenticated.mjs";

const ids = {
  primaryWorkspace: "00000000-0000-4000-8000-000000000001",
  foreignWorkspace: "00000000-0000-4000-8000-000000000002",
  foreignProject: "00000000-0000-4000-8000-000000000099",
  project: "00000000-0000-4000-8000-000000000010",
  attachment: "00000000-0000-4000-8000-000000000011",
  run: "00000000-0000-4000-8000-000000000012",
};
const CORE_AGENTS = ["Mike", "Emma", "Bob", "Alex", "David"];
// Format-only mock fixtures. Real signatures/expiry are checked by Control API.
const primaryToken = "fixture-primary.jwt-payload.not-a-signature";
const foreignToken = "fixture-foreign.jwt-payload.not-a-signature";
const uploadUrl =
  "https://storage.staging.atoms.dev/atoms-attachments/quarantine/source.txt?X-Amz-Signature=upload-signature";
const downloadUrl =
  "https://storage.staging.atoms.dev/atoms-attachments/clean/source.txt?X-Amz-Signature=download-signature";
const previewUrl =
  "https://signed-ticket.preview.staging.atoms.dev/";

test("missing, malformed or identical bearer tokens fail before any request", async () => {
  for (const invalid of [undefined, "private-token-canary", `${primaryToken}\n`, foreignToken]) {
    const input = configuration();
    input.primary.accessToken = invalid;
    let calls = 0;
    await assert.rejects(executeAuthenticatedStagingSmoke(input, {
      fetch: async () => { calls += 1; throw new Error("must not fetch"); },
    }), (error) => {
      assert.ok(!error.message.includes("private-token-canary"));
      assert.ok(!error.message.includes(primaryToken));
      return /bounded JWT|different bearer tokens/u.test(error.message);
    });
    assert.equal(calls, 0);
  }
});

test("Control API rejection of a JWT-shaped token stops before any resource write", async () => {
  const mock = createMockFetch();
  let writes = 0;
  await assert.rejects(executeAuthenticatedStagingSmoke(configuration(), {
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (!["GET", "OPTIONS"].includes(init.method ?? "GET")) writes += 1;
      if (url.pathname === "/v1/me" && new Headers(init.headers).has("authorization")) {
        return json({ code: "INVALID_ACCESS_TOKEN" }, 401);
      }
      return mock.fetch(input, init);
    },
  }), /primary identity returned HTTP 401/u);
  assert.equal(writes, 0);
});

test("different tokens resolving to the same verified user stop before resource writes", async () => {
  const mock = createMockFetch();
  let writes = 0;
  await assert.rejects(executeAuthenticatedStagingSmoke(configuration(), {
    fetch: async (input, init = {}) => {
      if (!["GET", "OPTIONS"].includes(init.method ?? "GET")) writes += 1;
      const response = await mock.fetch(input, init);
      if (new URL(String(input)).pathname === "/v1/me" && response.status === 200) {
        const body = await response.json();
        return json({ ...body, userId: "same-verified-directory-object" }, 200);
      }
      return response;
    },
  }), /two distinct verified users/u);
  assert.equal(writes, 0);
});

test("live command inputs require two exact confirmations and a bounded audit cost", () => {
  const valid = validateSmokeCommandOptions({
    environmentFile: "/etc/atoms/staging/staging.env",
    secretsDirectory: "/etc/atoms/staging/secrets",
    evidenceOut: "/var/lib/atoms/staging/evidence/authenticated-smoke.json",
    changeTicket: "GH-22",
    confirmation: SMOKE_CONFIRMATION,
    providerConfirmation: LIVE_PROVIDER_CONFIRMATION,
    maximumCostCad: "4",
  });
  assert.deepEqual(valid, { violations: [], maximumCostCad: 4 });

  const rejected = validateSmokeCommandOptions({
    environmentFile: "relative.env",
    secretsDirectory: "/etc/atoms/staging/secrets",
    evidenceOut: "/etc/atoms/staging/secrets/evidence.json",
    changeTicket: "bad ticket",
    confirmation: "RUN",
    providerConfirmation: "ACCEPT",
    maximumCostCad: "4.01",
  });
  assert.equal(rejected.maximumCostCad, undefined);
  assert.match(rejected.violations.join("\n"), /RUN_AUTHENTICATED/u);
  assert.match(rejected.violations.join("\n"), /I_ACCEPT_ONE_LIVE/u);
  assert.match(rejected.violations.join("\n"), /no more than 4/u);
  assert.match(rejected.violations.join("\n"), /absolute path/u);
  assert.match(rejected.violations.join("\n"), /outside the secrets directory/u);
});

test("authenticated smoke exercises the CLIENT_PORTAL capability route", async () => {
  const mock = createMockFetch();
  const result = await executeAuthenticatedStagingSmoke(
    configuration(),
    {
      fetch: mock.fetch,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      sleep: async () => {},
    },
  );

  assert.equal(result.evidence.outcome, "passed");
  assert.equal(result.evidence.identityProvider, "ENTRA_EXTERNAL_ID");
  assert.equal(result.evidence.projectType, "CLIENT_PORTAL");
  assert.ok(result.evidence.checks.includes("entra_control_api_identity"));
  assert.ok(result.evidence.checks.includes("project_capability_routing"));
  assert.deepEqual(result.evidence.orchestration.approvals, ["plan"]);
  assert.equal(result.evidence.orchestration.forcedReconnect, true);
  assert.equal(result.evidence.orchestration.resumedWithLastEventId, true);
  assert.deepEqual(result.evidence.orchestration.capabilities, [
    "product-planning",
    "requirements-architecture",
    "implementation",
    "validation",
    "data-design",
  ]);
  assert.deepEqual(result.evidence.orchestration.artifactAgents, CORE_AGENTS);
  assert.deepEqual(mock.lastEventIds, [null, "1", "2"]);
  assert.deepEqual(mock.approvals, [
    { scope: "plan", expectedControlVersion: 1 },
  ]);

  const serialized = JSON.stringify(result.evidence);
  for (const forbidden of [
    primaryToken,
    foreignToken,
    uploadUrl,
    downloadUrl,
    previewUrl,
    ids.primaryWorkspace,
    ids.foreignWorkspace,
    ids.foreignProject,
    ids.project,
    ids.attachment,
    ids.run,
    "primary-smoke@staging.atoms.dev",
    "foreign-smoke@staging.atoms.dev",
    "primary-smoke-user",
    "foreign-smoke-user",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(escapeRegex(forbidden), "u"));
  }
});

test("evidence guard rejects signed capabilities and secret values", () => {
  assert.throws(
    () =>
      assertRedactedEvidence(
        { outcome: "passed", preview: previewUrl },
        new Set(),
      ),
    /capability or token field/u,
  );
  assert.throws(
    () =>
      assertRedactedEvidence(
        { outcome: "passed", note: "secret-value" },
        new Set(["secret-value"]),
      ),
    /sensitive runtime value/u,
  );
});

test("evidence writer is mode-0600 and never overwrites an existing file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atoms-smoke-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const createdPath = join(directory, "created.json");
  const existingPath = join(directory, "existing.json");
  const evidence = { outcome: "passed", revision: "a".repeat(40) };

  await writeRedactedEvidence(createdPath, evidence, new Set());
  assert.equal((await stat(createdPath)).mode & 0o7777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(createdPath, "utf8")), evidence);

  await writeFile(existingPath, "keep-this-evidence\n", { mode: 0o600 });
  await chmod(existingPath, 0o600);
  await assert.rejects(
    writeRedactedEvidence(existingPath, evidence, new Set()),
    /already exists and will not be overwritten/u,
  );
  assert.equal(await readFile(existingPath, "utf8"), "keep-this-evidence\n");
});

function configuration() {
  return {
    webOrigin: "https://app.staging.atoms.dev",
    controlApiOrigin: "https://api.staging.atoms.dev",
    storageOrigin: "https://storage.staging.atoms.dev",
    previewBaseDomain: "preview.staging.atoms.dev",
    s3Bucket: "atoms-attachments",
    revision: "a".repeat(40),
    changeTicket: "GH-22",
    maximumCostCad: 4,
    timeoutMs: 60_000,
    primary: {
      accessToken: primaryToken,
    },
    foreign: {
      accessToken: foreignToken,
      projectId: ids.foreignProject,
    },
  };
}

function createMockFetch() {
  const lastEventIds = [];
  const approvals = [];
  let eventConnection = 0;
  let pendingApproval;
  let completed = false;
  let uploadedBytes;

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization");

    if (url.origin === "https://app.staging.atoms.dev") {
      return new Response("<html>Atoms</html>", {
        status: 200,
        headers: ingressHeaders({
          "content-security-policy":
            "default-src 'self'; connect-src 'self' https://api.staging.atoms.dev https://fixture-tenant.ciamlogin.com https://storage.staging.atoms.dev",
        }),
      });
    }

    if (url.origin === "https://storage.staging.atoms.dev") {
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { "access-control-allow-origin": "https://app.staging.atoms.dev" },
        });
      }
      if (method === "PUT") {
        assert.equal(url.href, uploadUrl);
        uploadedBytes = new Uint8Array(init.body);
        return new Response(null, { status: 200, headers: { etag: '"fixture-etag"' } });
      }
      assert.equal(url.href, downloadUrl);
      assert.ok(uploadedBytes);
      return new Response(uploadedBytes, { status: 200 });
    }

    if (url.origin === "https://signed-ticket.preview.staging.atoms.dev") {
      return new Response("<html>preview</html>", {
        status: 200,
        headers: ingressHeaders({
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; frame-ancestors https://app.staging.atoms.dev; object-src 'none'",
        }),
      });
    }

    assert.equal(url.origin, "https://api.staging.atoms.dev");
    if (["/healthz", "/readyz"].includes(url.pathname)) {
      return json({ status: "ok" }, 200, ingressHeaders());
    }
    if (url.pathname === "/v1/me" && method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { "access-control-allow-origin": "https://app.staging.atoms.dev" },
      });
    }
    if (url.pathname === "/v1/me" && authorization === null) {
      return json({ error: "authentication required" }, 401);
    }
    if (url.pathname === "/v1/me" && authorization === `Bearer ${primaryToken}`) {
      return json({
        userId: "primary-smoke-user",
        memberships: [
          { role: "ADMIN", workspace: { id: ids.primaryWorkspace } },
        ],
      });
    }
    if (url.pathname === "/v1/me" && authorization === `Bearer ${foreignToken}`) {
      return json({
        userId: "foreign-smoke-user",
        memberships: [
          { role: "MEMBER", workspace: { id: ids.foreignWorkspace } },
        ],
      });
    }
    if (url.pathname === `/v1/projects/${ids.foreignProject}`) {
      return authorization === `Bearer ${primaryToken}`
        ? json({ error: "not found" }, 404)
        : json({ id: ids.foreignProject, workspaceId: ids.foreignWorkspace });
    }
    if (url.pathname === "/v1/projects" && method === "POST") {
      const body = JSON.parse(String(init.body));
      assert.equal(body.workspaceId, ids.primaryWorkspace);
      assert.equal(body.projectType, "CLIENT_PORTAL");
      return json({
        id: ids.project,
        workspaceId: ids.primaryWorkspace,
        projectType: "CLIENT_PORTAL",
      }, 201);
    }
    if (
      url.pathname === `/v1/projects/${ids.project}/attachments/upload-intents`
    ) {
      const body = JSON.parse(String(init.body));
      assert.ok(body.sizeBytes > 0);
      return json(
        {
          attachment: { id: ids.attachment },
          upload: {
            method: "PUT",
            url: uploadUrl,
            headers: { "content-type": "text/plain" },
          },
        },
        201,
      );
    }
    if (
      url.pathname ===
        `/v1/projects/${ids.project}/attachments/${ids.attachment}/complete`
    ) {
      return json({ id: ids.attachment, status: "QUARANTINED" }, 202);
    }
    if (url.pathname === `/v1/projects/${ids.project}/attachments`) {
      return json({ items: [{ id: ids.attachment, status: "CLEAN" }] });
    }
    if (
      url.pathname ===
      `/v1/projects/${ids.project}/attachments/${ids.attachment}/download`
    ) {
      return json({ url: downloadUrl });
    }
    if (url.pathname === `/v1/projects/${ids.project}/runs` && method === "POST") {
      assert.match(headers.get("idempotency-key") ?? "", /^smoke-/u);
      const body = JSON.parse(String(init.body));
      assert.match(body.prompt, /agency client portal/u);
      return json({ id: ids.run, status: "PENDING", controlVersion: 0 }, 201);
    }
    if (url.pathname === `/v1/runs/${ids.run}/events`) {
      const lastEventId = headers.get("last-event-id");
      lastEventIds.push(lastEventId);
      const batches = [
        [event(1, "run.created", {})],
        [event(2, "approval.required", { version: "v1", scope: "plan", reason: "plan" })],
        [
          event(3, "preview.updated", {
            version: "v1",
            status: "READY",
            url: previewUrl,
          }),
          event(4, "run.completed", {}),
        ],
      ];
      const batch = batches[eventConnection];
      eventConnection += 1;
      if (eventConnection === 2) pendingApproval = "plan";
      if (eventConnection === 3) completed = true;
      return new Response(batch.join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }
    if (url.pathname === `/v1/runs/${ids.run}/actions`) {
      const body = JSON.parse(String(init.body));
      approvals.push({
        scope: body.approvalScope,
        expectedControlVersion: body.expectedControlVersion,
      });
      assert.equal(body.approvalScope, pendingApproval);
      pendingApproval = undefined;
      return json({ status: "PENDING", controlVersion: body.expectedControlVersion + 1 });
    }
    if (url.pathname === `/v1/runs/${ids.run}/artifacts`) {
      return json({
        items: CORE_AGENTS.map((agent) => ({ payload: { agent } })),
      });
    }
    if (url.pathname === `/v1/runs/${ids.run}`) {
      if (pendingApproval === "plan") {
        return json({ status: "PAUSED", controlVersion: 1 });
      }
      return json({
        status: completed ? "COMPLETED" : "RUNNING",
        controlVersion: completed ? 2 : 0,
      });
    }
    assert.fail(`Unexpected mock request: ${method} ${url.pathname}`);
  }

  return { fetch, lastEventIds, approvals };
}

function event(sequence, eventType, payload) {
  const envelope = {
    sequence,
    runId: ids.run,
    eventType,
    payload,
    occurredAt: "2026-08-30T12:00:00.000Z",
  };
  return `id: ${String(sequence)}\nevent: ${eventType}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function ingressHeaders(extra = {}) {
  return {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateStagingDeployment } from "./check-staging-deployment.mjs";

export const SMOKE_CONFIRMATION =
  "RUN_AUTHENTICATED_ATOMS_STAGING_SMOKE";
export const LIVE_PROVIDER_CONFIRMATION =
  "I_ACCEPT_ONE_LIVE_OPENAI_E2B_STAGING_RUN";
export const MAX_ALLOWED_COST_CAD = 4;

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const REQUIRED_AGENTS = [
  "Mike",
  "Emma",
  "Bob",
  "Alex",
  "David",
  "Sarah",
  "Adrian",
];
const TERMINAL_ATTACHMENT_STATUSES = new Set([
  "REJECTED",
  "FAILED",
  "EXPIRED",
]);
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;

export function validateSmokeCommandOptions(options) {
  const violations = [];
  if (options.confirmation !== SMOKE_CONFIRMATION) {
    violations.push(`--confirmation must equal ${SMOKE_CONFIRMATION}`);
  }
  if (options.providerConfirmation !== LIVE_PROVIDER_CONFIRMATION) {
    violations.push(
      `--provider-confirmation must equal ${LIVE_PROVIDER_CONFIRMATION}`,
    );
  }
  if (!/^[A-Z][A-Z0-9-]{1,63}$/u.test(options.changeTicket ?? "")) {
    violations.push("--change-ticket must be a normalized identifier");
  }
  const maximumCostCad = parseMaximumCost(options.maximumCostCad);
  if (maximumCostCad === undefined) {
    violations.push(
      `--max-cost-cad must be greater than zero and no more than ${String(MAX_ALLOWED_COST_CAD)}`,
    );
  }
  for (const [name, value] of [
    ["--env-file", options.environmentFile],
    ["--secrets-dir", options.secretsDirectory],
    ["--evidence-out", options.evidenceOut],
  ]) {
    if (typeof value !== "string" || !isAbsolute(value)) {
      violations.push(`${name} must use an absolute path`);
    }
  }
  if (
    typeof options.evidenceOut === "string" &&
    isAbsolute(options.evidenceOut)
  ) {
    if (isInside(options.evidenceOut, repositoryRoot)) {
      violations.push("--evidence-out must be outside the repository");
    }
    if (
      typeof options.secretsDirectory === "string" &&
      isAbsolute(options.secretsDirectory) &&
      isInside(options.evidenceOut, options.secretsDirectory)
    ) {
      violations.push("--evidence-out must be outside the secrets directory");
    }
  }
  return { violations, maximumCostCad };
}

export async function executeAuthenticatedStagingSmoke(
  configuration,
  dependencies = {},
) {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.randomUUID ?? randomUUID;
  const sleep = dependencies.sleep ?? delay;
  const deadline = Date.now() + (configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const checks = [];
  const sensitiveValues = new Set([
    configuration.primary.email,
    configuration.primary.password,
    configuration.foreign.email,
    configuration.foreign.password,
    configuration.foreign.projectId,
    configuration.supabasePublishableKey,
  ]);

  const webResponse = await request(
    fetchImplementation,
    configuration.webOrigin,
    { method: "GET" },
    deadline,
    "web ingress",
  );
  requireStatus(webResponse, [200], "web ingress");
  assertIngressHeaders(webResponse, "web ingress");
  const webCsp = webResponse.headers.get("content-security-policy") ?? "";
  if (!cspConnectSources(webCsp).includes(configuration.storageOrigin)) {
    throw new Error("web CSP does not allow the exact storage origin");
  }
  checks.push("web_https_and_csp");

  for (const path of ["/healthz", "/readyz"]) {
    const response = await request(
      fetchImplementation,
      new URL(path, configuration.controlApiOrigin),
      { method: "GET" },
      deadline,
      `Control API ${path}`,
    );
    requireStatus(response, [200], `Control API ${path}`);
    assertIngressHeaders(response, `Control API ${path}`);
  }
  checks.push("control_api_health");

  const cors = await request(
    fetchImplementation,
    new URL("/v1/me", configuration.controlApiOrigin),
    {
      method: "OPTIONS",
      headers: {
        origin: configuration.webOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    },
    deadline,
    "Control API CORS preflight",
  );
  requireStatus(cors, [200, 204], "Control API CORS preflight");
  requireCorsOrigin(cors, configuration.webOrigin, "Control API CORS preflight");
  const unauthenticated = await request(
    fetchImplementation,
    new URL("/v1/me", configuration.controlApiOrigin),
    { method: "GET" },
    deadline,
    "unauthenticated API boundary",
  );
  requireStatus(unauthenticated, [401], "unauthenticated API boundary");
  checks.push("cors_and_auth_boundary");

  const primaryToken = await signIn(
    fetchImplementation,
    configuration,
    configuration.primary,
    deadline,
  );
  const foreignToken = await signIn(
    fetchImplementation,
    configuration,
    configuration.foreign,
    deadline,
  );
  sensitiveValues.add(primaryToken);
  sensitiveValues.add(foreignToken);

  const primaryMe = await apiJson(
    fetchImplementation,
    configuration,
    primaryToken,
    "/v1/me",
    { method: "GET" },
    [200],
    deadline,
    "primary identity",
  );
  const foreignMe = await apiJson(
    fetchImplementation,
    configuration,
    foreignToken,
    "/v1/me",
    { method: "GET" },
    [200],
    deadline,
    "foreign witness identity",
  );
  const primaryMemberships = memberships(primaryMe, "primary identity");
  const foreignMemberships = memberships(foreignMe, "foreign witness identity");
  if (
    typeof primaryMe?.userId !== "string" ||
    typeof foreignMe?.userId !== "string" ||
    primaryMe.userId === foreignMe.userId
  ) {
    throw new Error("authenticated smoke requires two distinct verified users");
  }
  sensitiveValues.add(primaryMe.userId);
  sensitiveValues.add(foreignMe.userId);
  const administrativeMembership = primaryMemberships.find((membership) =>
    ["OWNER", "ADMIN"].includes(membership.role),
  );
  if (administrativeMembership === undefined) {
    throw new Error("primary smoke identity needs an administrative workspace role");
  }

  const primaryForeignRead = await request(
    fetchImplementation,
    new URL(
      `/v1/projects/${configuration.foreign.projectId}`,
      configuration.controlApiOrigin,
    ),
    { method: "GET", headers: bearerHeaders(primaryToken) },
    deadline,
    "cross-workspace non-enumeration",
  );
  requireStatus(primaryForeignRead, [404], "cross-workspace non-enumeration");
  const foreignProject = await apiJson(
    fetchImplementation,
    configuration,
    foreignToken,
    `/v1/projects/${configuration.foreign.projectId}`,
    { method: "GET" },
    [200],
    deadline,
    "foreign project witness",
  );
  const foreignWorkspaceId = requireUuid(
    foreignProject?.workspaceId,
    "foreign project workspace",
  );
  if (
    primaryMemberships.some(
      (membership) => membership.workspace.id === foreignWorkspaceId,
    )
  ) {
    throw new Error("foreign witness project belongs to a primary workspace");
  }
  if (
    !foreignMemberships.some(
      (membership) => membership.workspace.id === foreignWorkspaceId,
    )
  ) {
    throw new Error("foreign witness identity cannot prove the foreign workspace");
  }
  checks.push("two_identity_workspace_isolation");

  const suffix = `${now().getTime().toString(36)}-${createId().slice(0, 8)}`;
  const project = await apiJson(
    fetchImplementation,
    configuration,
    primaryToken,
    "/v1/projects",
    {
      method: "POST",
      body: JSON.stringify({
        workspaceId: administrativeMembership.workspace.id,
        name: `Authenticated staging smoke ${suffix}`,
        slug: `authenticated-smoke-${suffix}`.toLowerCase(),
        description: "Ephemeral authenticated staging acceptance project",
      }),
    },
    [201],
    deadline,
    "project creation",
  );
  const projectId = requireUuid(project?.id, "created project");
  sensitiveValues.add(projectId);
  sensitiveValues.add(administrativeMembership.workspace.id);

  const attachmentBytes = new TextEncoder().encode(
    `Atoms authenticated staging smoke ${suffix}\n`,
  );
  const uploadIntent = await apiJson(
    fetchImplementation,
    configuration,
    primaryToken,
    `/v1/projects/${projectId}/attachments/upload-intents`,
    {
      method: "POST",
      body: JSON.stringify({
        fileName: "authenticated-smoke.txt",
        contentType: "text/plain",
        sizeBytes: attachmentBytes.byteLength,
      }),
    },
    [201],
    deadline,
    "attachment upload intent",
  );
  const attachmentId = requireUuid(
    uploadIntent?.attachment?.id,
    "attachment upload intent",
  );
  sensitiveValues.add(attachmentId);
  const upload = requireSignedRequest(uploadIntent?.upload, "PUT");
  assertStorageCapability(upload.url, configuration);
  sensitiveValues.add(upload.url);

  const requestedHeaders = Object.keys(upload.headers).join(",");
  const storageCors = await request(
    fetchImplementation,
    upload.url,
    {
      method: "OPTIONS",
      headers: {
        origin: configuration.webOrigin,
        "access-control-request-method": "PUT",
        ...(requestedHeaders.length === 0
          ? {}
          : { "access-control-request-headers": requestedHeaders }),
      },
    },
    deadline,
    "storage CORS preflight",
  );
  requireStatus(storageCors, [200, 204], "storage CORS preflight");
  requireCorsOrigin(storageCors, configuration.webOrigin, "storage CORS preflight");
  const uploaded = await request(
    fetchImplementation,
    upload.url,
    { method: "PUT", headers: upload.headers, body: attachmentBytes },
    deadline,
    "attachment upload",
  );
  requireStatus(uploaded, [200, 204], "attachment upload");
  const etag = uploaded.headers.get("etag");
  await apiJson(
    fetchImplementation,
    configuration,
    primaryToken,
    `/v1/projects/${projectId}/attachments/${attachmentId}/complete`,
    {
      method: "POST",
      body: JSON.stringify(etag === null ? {} : { etag }),
    },
    [202],
    deadline,
    "attachment completion",
  );
  await waitForCleanAttachment({
    fetchImplementation,
    configuration,
    token: primaryToken,
    projectId,
    attachmentId,
    deadline: Math.min(deadline, Date.now() + 2 * 60 * 1_000),
    sleep,
  });
  const downloadIntent = await apiJson(
    fetchImplementation,
    configuration,
    primaryToken,
    `/v1/projects/${projectId}/attachments/${attachmentId}/download`,
    { method: "GET" },
    [200],
    deadline,
    "attachment download intent",
  );
  if (typeof downloadIntent?.url !== "string") {
    throw new Error("attachment download intent omitted its signed URL");
  }
  assertStorageCapability(downloadIntent.url, configuration);
  sensitiveValues.add(downloadIntent.url);
  const downloaded = await request(
    fetchImplementation,
    downloadIntent.url,
    { method: "GET" },
    deadline,
    "attachment download",
  );
  requireStatus(downloaded, [200], "attachment download");
  const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
  if (!Buffer.from(downloadedBytes).equals(Buffer.from(attachmentBytes))) {
    throw new Error("downloaded attachment bytes differ from the uploaded bytes");
  }
  checks.push("attachment_upload_scan_download");

  const run = await apiJson(
    fetchImplementation,
    configuration,
    primaryToken,
    `/v1/projects/${projectId}/runs`,
    {
      method: "POST",
      headers: { "idempotency-key": `smoke-${createId()}` },
      body: JSON.stringify({
        prompt:
          "Build a small authenticated product landing page. Require explicit plan approval, produce at least one evidence-aware CTA variant, validate the generated project, and publish a signed preview.",
        attachmentIds: [attachmentId],
      }),
    },
    [201],
    deadline,
    "live agent run creation",
  );
  const runId = requireUuid(run?.id, "created run");
  sensitiveValues.add(runId);
  const orchestration = await observeRun({
    fetchImplementation,
    configuration,
    token: primaryToken,
    runId,
    deadline,
    sleep,
  });
  sensitiveValues.add(orchestration.previewUrl);
  checks.push("sse_reconnect_and_scoped_approvals");

  const artifacts = await apiJson(
    fetchImplementation,
    configuration,
    primaryToken,
    `/v1/runs/${runId}/artifacts`,
    { method: "GET" },
    [200],
    deadline,
    "run artifacts",
  );
  const artifactItems = Array.isArray(artifacts?.items) ? artifacts.items : [];
  const artifactAgents = new Set(
    artifactItems
      .map((item) => item?.payload?.agent)
      .filter((agent) => typeof agent === "string"),
  );
  for (const agent of REQUIRED_AGENTS) {
    if (!artifactAgents.has(agent)) {
      throw new Error(`run artifacts are missing the ${agent} agent output`);
    }
  }
  checks.push("seven_agent_artifacts");

  assertPreviewCapability(orchestration.previewUrl, configuration);
  const preview = await request(
    fetchImplementation,
    orchestration.previewUrl,
    { method: "GET" },
    deadline,
    "signed preview",
  );
  requireStatus(preview, [200], "signed preview");
  assertIngressHeaders(preview, "signed preview");
  const previewCsp = preview.headers.get("content-security-policy") ?? "";
  if (!previewCsp.includes(`frame-ancestors ${configuration.webOrigin}`)) {
    throw new Error("signed preview does not restrict framing to the web origin");
  }
  if (preview.headers.get("cache-control") !== "no-store") {
    throw new Error("signed preview must use cache-control: no-store");
  }
  checks.push("signed_preview_security");

  const completedRun = await apiJson(
    fetchImplementation,
    configuration,
    primaryToken,
    `/v1/runs/${runId}`,
    { method: "GET" },
    [200],
    deadline,
    "completed run",
  );
  if (completedRun?.status !== "COMPLETED") {
    throw new Error("live agent run did not reach COMPLETED");
  }
  checks.push("run_completed");

  const evidence = {
    schemaVersion: "atoms.staging.authenticated-smoke.v1",
    outcome: "passed",
    completedAt: now().toISOString(),
    changeTicket: configuration.changeTicket,
    revision: configuration.revision,
    costBoundary: {
      currency: "CAD",
      approvedMaximum: configuration.maximumCostCad,
      enforcement: "operator-audit-boundary-not-provider-hard-limit",
    },
    checks,
    attachment: {
      bytes: attachmentBytes.byteLength,
      sha256: createHash("sha256").update(attachmentBytes).digest("hex"),
    },
    orchestration: {
      forcedReconnect: orchestration.forcedReconnect,
      resumedWithLastEventId: orchestration.resumedWithLastEventId,
      approvals: orchestration.approvals,
      artifactAgents: REQUIRED_AGENTS,
    },
  };
  assertRedactedEvidence(evidence, sensitiveValues);
  return { evidence, sensitiveValues };
}

async function observeRun(options) {
  let cursor = 0;
  let connection = 0;
  let pendingApproval;
  let previewUrl;
  let completed = false;
  let resumedWithLastEventId = false;
  const approvals = [];

  while (!completed) {
    if (Date.now() >= options.deadline) {
      throw new Error("live agent run exceeded the authenticated smoke timeout");
    }
    const stopAfterFirstEvent = connection === 0;
    let eventsRead = 0;
    const lastEventId = cursor === 0 ? undefined : cursor;
    if (lastEventId !== undefined) resumedWithLastEventId = true;
    const result = await readSseConnection({
      fetchImplementation: options.fetchImplementation,
      url: new URL(
        `/v1/runs/${options.runId}/events`,
        options.configuration.controlApiOrigin,
      ),
      token: options.token,
      lastEventId,
      deadline: options.deadline,
      async onEvent(event) {
        if (!Number.isInteger(event.sequence) || event.sequence <= cursor) {
          throw new Error("SSE event sequence did not advance monotonically");
        }
        cursor = event.sequence;
        eventsRead += 1;
        if (
          event.eventType === "approval.required" ||
          event.eventType === "approval_required"
        ) {
          const scope = event.payload?.scope;
          if (!["plan", "content"].includes(scope)) {
            throw new Error("approval event omitted its supported scope");
          }
          if (approvals.includes(scope)) {
            throw new Error("run requested the same approval scope more than once");
          }
          pendingApproval = scope;
        }
        if (event.eventType === "preview.updated") {
          if (
            event.payload?.status === "READY" &&
            typeof event.payload?.url === "string"
          ) {
            previewUrl = event.payload.url;
          }
        }
        if (event.eventType === "run.completed") completed = true;
        if (event.eventType === "run.failed" || event.eventType === "error") {
          throw new Error("live agent run emitted a failure event");
        }
      },
      shouldStop: () =>
        stopAfterFirstEvent || pendingApproval !== undefined || completed,
    });
    connection += 1;
    if (connection === 1 && eventsRead === 0) {
      throw new Error("initial SSE connection returned no durable event");
    }

    if (pendingApproval !== undefined) {
      const scope = pendingApproval;
      pendingApproval = undefined;
      const current = await apiJson(
        options.fetchImplementation,
        options.configuration,
        options.token,
        `/v1/runs/${options.runId}`,
        { method: "GET" },
        [200],
        options.deadline,
        `${scope} approval state`,
      );
      if (
        current?.status !== "PAUSED" ||
        !Number.isInteger(current?.controlVersion)
      ) {
        throw new Error(`${scope} approval did not expose a PAUSED CAS state`);
      }
      await apiJson(
        options.fetchImplementation,
        options.configuration,
        options.token,
        `/v1/runs/${options.runId}/actions`,
        {
          method: "POST",
          body: JSON.stringify({
            action: "approve",
            approvalScope: scope,
            expectedStatus: "PAUSED",
            expectedControlVersion: current.controlVersion,
            reason: `Authenticated staging smoke approved ${scope}`,
          }),
        },
        [200],
        options.deadline,
        `${scope} approval action`,
      );
      approvals.push(scope);
      continue;
    }

    if (!completed && (result.ended || eventsRead === 0)) {
      const current = await apiJson(
        options.fetchImplementation,
        options.configuration,
        options.token,
        `/v1/runs/${options.runId}`,
        { method: "GET" },
        [200],
        options.deadline,
        "run progress",
      );
      if (current?.status === "FAILED" || current?.status === "CANCELLED") {
        throw new Error("live agent run entered a failed terminal state");
      }
      if (current?.status === "COMPLETED") completed = true;
      if (!completed) await options.sleep(500);
    }
  }

  if (approvals.join(",") !== "plan,content") {
    throw new Error("live run must exercise plan then content approvals");
  }
  if (typeof previewUrl !== "string") {
    throw new Error("completed run did not emit a ready signed preview");
  }
  return {
    approvals,
    previewUrl,
    forcedReconnect: connection >= 2,
    resumedWithLastEventId,
  };
}

async function readSseConnection(options) {
  const headers = bearerHeaders(options.token);
  headers.accept = "text/event-stream";
  if (options.lastEventId !== undefined) {
    headers["last-event-id"] = String(options.lastEventId);
  }
  const response = await request(
    options.fetchImplementation,
    options.url,
    { method: "GET", headers },
    options.deadline,
    "run event stream",
    true,
  );
  requireStatus(response, [200], "run event stream");
  if (!(response.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    throw new Error("run event stream returned the wrong content type");
  }
  if (response.body === null) {
    throw new Error("run event stream returned no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        ended = true;
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseEvent(block);
        if (event !== undefined) {
          await options.onEvent(event);
          if (options.shouldStop(event)) {
            await reader.cancel();
            return { ended: false };
          }
        }
      }
      if (chunk.done) return { ended };
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function parseSseEvent(block) {
  if (block.length === 0 || block.startsWith(":")) return undefined;
  let id;
  let eventType;
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (id === undefined || eventType === undefined || data.length === 0) {
    throw new Error("run event stream emitted an incomplete event");
  }
  let envelope;
  try {
    envelope = JSON.parse(data.join("\n"));
  } catch {
    throw new Error("run event stream emitted invalid JSON");
  }
  if (String(envelope?.sequence) !== id || envelope?.eventType !== eventType) {
    throw new Error("run event stream envelope does not match its SSE metadata");
  }
  return envelope;
}

async function waitForCleanAttachment(options) {
  while (Date.now() < options.deadline) {
    const response = await apiJson(
      options.fetchImplementation,
      options.configuration,
      options.token,
      `/v1/projects/${options.projectId}/attachments`,
      { method: "GET" },
      [200],
      options.deadline,
      "attachment scan status",
    );
    const attachment = Array.isArray(response?.items)
      ? response.items.find((item) => item?.id === options.attachmentId)
      : undefined;
    if (attachment?.status === "CLEAN") return;
    if (TERMINAL_ATTACHMENT_STATUSES.has(attachment?.status)) {
      throw new Error("attachment scan entered a failed terminal state");
    }
    await options.sleep(1_000);
  }
  throw new Error("attachment scan did not reach CLEAN before its timeout");
}

async function signIn(fetchImplementation, configuration, identity, deadline) {
  const response = await requestJson(
    fetchImplementation,
    new URL(
      "/auth/v1/token?grant_type=password",
      configuration.supabaseOrigin,
    ),
    {
      method: "POST",
      headers: {
        apikey: configuration.supabasePublishableKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: identity.email,
        password: identity.password,
      }),
    },
    [200],
    deadline,
    "Supabase password authentication",
  );
  if (
    typeof response?.access_token !== "string" ||
    response.access_token.length < 20
  ) {
    throw new Error("Supabase authentication returned no access token");
  }
  return response.access_token;
}

async function apiJson(
  fetchImplementation,
  configuration,
  token,
  path,
  init,
  expectedStatuses,
  deadline,
  label,
) {
  return requestJson(
    fetchImplementation,
    new URL(path, configuration.controlApiOrigin),
    {
      ...init,
      headers: {
        ...bearerHeaders(token),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    },
    expectedStatuses,
    deadline,
    label,
  );
}

async function requestJson(
  fetchImplementation,
  url,
  init,
  expectedStatuses,
  deadline,
  label,
) {
  const response = await request(
    fetchImplementation,
    url,
    init,
    deadline,
    label,
  );
  requireStatus(response, expectedStatuses, label);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function request(
  fetchImplementation,
  url,
  init,
  deadline,
  label,
  streaming = false,
) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${label} exceeded the smoke timeout`);
  const timeoutMs = streaming ? remaining : Math.min(remaining, 30_000);
  try {
    return await fetchImplementation(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`${label} request failed`);
  }
}

function memberships(value, label) {
  if (!Array.isArray(value?.memberships) || value.memberships.length === 0) {
    throw new Error(`${label} has no staging workspace membership`);
  }
  return value.memberships.map((membership) => ({
    role: membership?.role,
    workspace: {
      id: requireUuid(membership?.workspace?.id, `${label} workspace`),
    },
  }));
}

function requireSignedRequest(value, method) {
  if (
    value?.method !== method ||
    typeof value?.url !== "string" ||
    typeof value?.headers !== "object" ||
    value.headers === null ||
    Array.isArray(value.headers)
  ) {
    throw new Error("attachment upload intent is incomplete");
  }
  return { method, url: value.url, headers: value.headers };
}

function assertStorageCapability(value, configuration) {
  const url = new URL(value);
  if (
    url.origin !== configuration.storageOrigin ||
    !url.pathname.startsWith(`/${configuration.s3Bucket}/`) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("signed attachment URL escaped the public storage boundary");
  }
  if (!url.searchParams.has("X-Amz-Signature")) {
    throw new Error("attachment URL is not an AWS Signature V4 capability");
  }
}

function assertPreviewCapability(value, configuration) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(`.${configuration.previewBaseDomain}`) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("signed preview URL escaped the preview hostname boundary");
  }
}

function assertIngressHeaders(response, label) {
  if (!/^max-age=\d+/u.test(response.headers.get("strict-transport-security") ?? "")) {
    throw new Error(`${label} omitted HSTS`);
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    throw new Error(`${label} omitted X-Content-Type-Options`);
  }
  if (response.headers.get("referrer-policy") !== "no-referrer") {
    throw new Error(`${label} omitted Referrer-Policy`);
  }
}

function cspConnectSources(policy) {
  const directive = policy
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("connect-src "));
  return directive === undefined ? [] : directive.split(/\s+/u).slice(1);
}

function requireCorsOrigin(response, origin, label) {
  if (response.headers.get("access-control-allow-origin") !== origin) {
    throw new Error(`${label} did not allow the exact web origin`);
  }
}

function requireStatus(response, expected, label) {
  if (!expected.includes(response.status)) {
    throw new Error(`${label} returned HTTP ${String(response.status)}`);
  }
}

function requireUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error(`${label} did not return a UUID`);
  }
  return value;
}

function bearerHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

export function assertRedactedEvidence(evidence, sensitiveValues) {
  const serialized = JSON.stringify(evidence);
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value.length > 0 && serialized.includes(value)) {
      throw new Error("redacted evidence contains a sensitive runtime value");
    }
  }
  if (
    /X-Amz-(?:Algorithm|Credential|Signature)|https?:\/\//iu.test(serialized) ||
    /(?:access|refresh)[_-]?token/iu.test(serialized)
  ) {
    throw new Error("redacted evidence contains a capability or token field");
  }
}

export async function writeRedactedEvidence(path, evidence, sensitiveValues) {
  assertRedactedEvidence(evidence, sensitiveValues);
  const parent = dirname(path);
  const canonicalParent = await realpath(parent);
  if (resolve(parent) !== canonicalParent) {
    throw new Error("evidence parent directory must not traverse symlinks");
  }
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
    }
    if (error?.code === "EEXIST") {
      throw new Error("evidence output already exists and will not be overwritten");
    }
    throw error;
  }
  await handle.close();
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o7777) !== 0o600) {
    await rm(path, { force: true }).catch(() => undefined);
    throw new Error("evidence output must be a regular mode-0600 file");
  }
}

function parseMaximumCost(value) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(String(value ?? ""))) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_ALLOWED_COST_CAD
    ? parsed
    : undefined;
}

function parseArguments(arguments_) {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const options = {};
  const names = new Map([
    ["--env-file", "environmentFile"],
    ["--secrets-dir", "secretsDirectory"],
    ["--change-ticket", "changeTicket"],
    ["--evidence-out", "evidenceOut"],
    ["--confirmation", "confirmation"],
    ["--provider-confirmation", "providerConfirmation"],
    ["--max-cost-cad", "maximumCostCad"],
  ]);
  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    const property = names.get(argument);
    if (property === undefined) {
      throw new Error(`Unknown authenticated smoke argument: ${argument}`);
    }
    const value = normalized[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (options[property] !== undefined) {
      throw new Error(`${argument} may be supplied only once`);
    }
    options[property] = value;
    index += 1;
  }
  return options;
}

async function loadConfiguration(options, maximumCostCad) {
  const publicEnvironment = parseEnvironment(
    await readFile(options.environmentFile, "utf8"),
  );
  const smokeEnvironment = parseEnvironment(
    await readFile(
      resolve(options.secretsDirectory, "authenticated-smoke.env"),
      "utf8",
    ),
  );
  return {
    webOrigin: new URL(publicEnvironment.ATOMS_WEB_ORIGIN).origin,
    controlApiOrigin: new URL(publicEnvironment.ATOMS_CONTROL_API_ORIGIN).origin,
    storageOrigin: new URL(publicEnvironment.ATOMS_STORAGE_ORIGIN).origin,
    supabaseOrigin: new URL(publicEnvironment.ATOMS_SUPABASE_URL).origin,
    supabasePublishableKey: publicEnvironment.ATOMS_SUPABASE_PUBLISHABLE_KEY,
    previewBaseDomain: publicEnvironment.ATOMS_PREVIEW_BASE_DOMAIN,
    s3Bucket: publicEnvironment.ATOMS_S3_BUCKET,
    revision: publicEnvironment.ATOMS_IMAGE_TAG,
    changeTicket: options.changeTicket,
    maximumCostCad,
    primary: {
      email: smokeEnvironment.ATOMS_SMOKE_PRIMARY_EMAIL,
      password: smokeEnvironment.ATOMS_SMOKE_PRIMARY_PASSWORD,
    },
    foreign: {
      email: smokeEnvironment.ATOMS_SMOKE_FOREIGN_EMAIL,
      password: smokeEnvironment.ATOMS_SMOKE_FOREIGN_PASSWORD,
      projectId: smokeEnvironment.ATOMS_SMOKE_FOREIGN_PROJECT_ID,
    },
  };
}

function parseEnvironment(content) {
  const environment = {};
  for (const line of content.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("deployment environment is malformed");
    const name = line.slice(0, separator).trim();
    if (Object.hasOwn(environment, name)) {
      throw new Error("deployment environment contains a duplicate assignment");
    }
    environment[name] = line.slice(separator + 1);
  }
  return environment;
}

function assertRepositoryRevision(revision) {
  const head = git(["rev-parse", "HEAD"]);
  if (head !== revision) {
    throw new Error("checked-out HEAD does not match ATOMS_IMAGE_TAG");
  }
  if (git(["status", "--porcelain", "--untracked-files=all"]).length > 0) {
    throw new Error("authenticated smoke requires a clean checkout");
  }
}

function git(arguments_) {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function isInside(path, directory) {
  const fromDirectory = relative(resolve(directory), resolve(path));
  return (
    fromDirectory === "" ||
    (!fromDirectory.startsWith("..") && !isAbsolute(fromDirectory))
  );
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid arguments");
    process.exitCode = 1;
    return;
  }
  const validation = validateSmokeCommandOptions(options);
  if (validation.violations.length > 0) {
    for (const violation of validation.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }

  const preflight = await validateStagingDeployment({
    environmentFile: options.environmentFile,
    secretsDirectory: options.secretsDirectory,
  });
  if (!preflight.ok) {
    console.error("Authenticated smoke stopped because staging preflight failed.");
    for (const violation of preflight.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }

  try {
    const configuration = await loadConfiguration(
      options,
      validation.maximumCostCad,
    );
    assertRepositoryRevision(configuration.revision);
    const result = await executeAuthenticatedStagingSmoke(configuration);
    await writeRedactedEvidence(
      options.evidenceOut,
      result.evidence,
      result.sensitiveValues,
    );
    console.log("Authenticated staging smoke passed; redacted evidence was written.");
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Authenticated staging smoke failed safely",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}

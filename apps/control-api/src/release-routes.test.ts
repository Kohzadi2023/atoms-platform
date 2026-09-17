import assert from "node:assert/strict";
import test from "node:test";

import type { CreateProjectInput, JsonValue } from "@atoms/contracts";

import { buildControlApi } from "./app.js";
import { StaticTokenAuthenticator, type AuthenticatedPrincipal } from "./auth.js";
import type { ReleaseAssessmentRecord } from "./release-domain.js";
import type {
  ReleaseControlRepository,
  TriggerReleaseAssessmentResult,
} from "./release-repository.js";
import type {
  ControlRepository,
  CreateRunWithIdempotencyResult,
  PutProjectFileResult,
  WorkspaceMembershipRecord,
} from "./repository.js";
import type { RunQueue } from "./run-queue.js";

const WORKSPACE_A = "00000000-0000-4000-8000-000000000301";
const PROJECT_A = "00000000-0000-4000-8000-000000000302";
const RUN_A = "00000000-0000-4000-8000-000000000303";
const ASSESSMENT_READY = "00000000-0000-4000-8000-000000000304";
const ASSESSMENT_BLOCKED = "00000000-0000-4000-8000-000000000305";
const NOW = new Date("2026-09-14T00:10:00.000Z");

const TOKENS = { member: "token-member", outsider: "token-outsider" } as const;
const USERS = { member: "user-member", outsider: "user-outsider" } as const;

function principal(userId: string): AuthenticatedPrincipal {
  const issuedAt = Math.floor(NOW.getTime() / 1_000);
  return {
    userId,
    subject: userId,
    issuer: "urn:atoms:test",
    audience: ["atoms-control-api"],
    issuedAt,
    notBefore: issuedAt,
    expiresAt: issuedAt + 3600,
  };
}

class NoopControlRepository implements ControlRepository {
  async listWorkspaceMemberships(): Promise<readonly WorkspaceMembershipRecord[]> {
    return [];
  }
  async getWorkspaceMembership(): Promise<null> {
    return null;
  }
  async updateWorkspacePlan(): Promise<never> {
    throw new Error("not used");
  }
  async createProject(_input: CreateProjectInput): Promise<never> {
    throw new Error("not used");
  }
  async getProject(): Promise<null> {
    return null;
  }
  async createRun(): Promise<null> {
    return null;
  }
  async createRunWithIdempotency(): Promise<CreateRunWithIdempotencyResult> {
    return { kind: "project_not_found" };
  }
  async getRun(): Promise<null> {
    return null;
  }
  async transitionRun(): Promise<null> {
    return null;
  }
  async markRunFailed(_runId: string, _v: number, _error: JsonValue): Promise<void> {}
  async listRunEventsAfter(): Promise<[]> {
    return [];
  }
  async listRunArtifacts(): Promise<[]> {
    return [];
  }
  async listProjectFiles(): Promise<null> {
    return null;
  }
  async getProjectFile(): Promise<null> {
    return null;
  }
  async putProjectFile(): Promise<PutProjectFileResult> {
    return { kind: "project_not_found" };
  }
  async close(): Promise<void> {}
}

class NoopRunQueue implements RunQueue {
  async enqueue(): Promise<void> {}
  async close(): Promise<void> {}
}

function assessment(overrides: Partial<ReleaseAssessmentRecord> = {}): ReleaseAssessmentRecord {
  return {
    id: ASSESSMENT_READY,
    workspaceId: WORKSPACE_A,
    projectId: PROJECT_A,
    runId: RUN_A,
    controlVersion: 3,
    attempt: 1,
    source: "MANUAL",
    snapshotSha256: "a".repeat(64),
    status: "READY",
    acceptanceTaskId: "00000000-0000-4000-8000-000000000400",
    policy: { requiredChecks: ["LINT"], maxEvidenceAgeSeconds: 86_400 },
    checks: [],
    traceToAcceptance: [],
    issues: [],
    evaluatedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

// Only user-member is a member of WORKSPACE_A/PROJECT_A; user-outsider has no
// membership record for it at all -- this is the tenant-isolation fixture.
class FakeReleaseRepository implements ReleaseControlRepository {
  triggerResult: TriggerReleaseAssessmentResult = { kind: "ok", assessment: assessment() };
  triggerCalls: Array<{ readonly userId: string; readonly projectId: string }> = [];

  async getProjectWorkspaceMembership(
    userId: string,
    projectId: string,
  ): Promise<{ readonly workspaceId: string; readonly role: "OWNER" | "ADMIN" | "MEMBER" } | null> {
    if (userId === USERS.member && projectId === PROJECT_A) {
      return { workspaceId: WORKSPACE_A, role: "MEMBER" };
    }
    return null;
  }

  async triggerReleaseAssessment(
    userId: string,
    projectId: string,
  ): Promise<TriggerReleaseAssessmentResult> {
    this.triggerCalls.push({ userId, projectId });
    return this.triggerResult;
  }

  async getReleaseAssessment(
    userId: string,
    assessmentId: string,
  ): Promise<ReleaseAssessmentRecord | null> {
    if (userId !== USERS.member) return null;
    if (assessmentId === ASSESSMENT_READY) return assessment();
    if (assessmentId === ASSESSMENT_BLOCKED) {
      return assessment({
        id: ASSESSMENT_BLOCKED,
        status: "BLOCKED",
        acceptanceTaskId: null,
        issues: [{ code: "MISSING_ACCEPTANCE" }],
      });
    }
    return null;
  }
}

async function fixture() {
  const repository = new FakeReleaseRepository();
  const app = await buildControlApi({
    repository: new NoopControlRepository(),
    runQueue: new NoopRunQueue(),
    authenticator: new StaticTokenAuthenticator(
      new Map([
        [TOKENS.member, principal(USERS.member)],
        [TOKENS.outsider, principal(USERS.outsider)],
      ]),
    ),
    authRequired: true,
    now: () => NOW,
    releaseOperations: { repository },
  });
  return { app, repository };
}

test("triggering a release assessment requires authentication", async () => {
  const { app } = await fixture();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_A}/release-assessments`,
      payload: {},
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("a workspace member can trigger an observe-only assessment and never a deployment authority", async () => {
  const { app, repository } = await fixture();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_A}/release-assessments`,
      headers: { authorization: `Bearer ${TOKENS.member}` },
      payload: {},
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.mode, "OBSERVE_ONLY");
    assert.equal(body.status, "READY");
    // A manually triggered assessment is tagged distinctly from the worker's
    // own automatic assessment so the two can never silently overwrite each
    // other at the same (runId, controlVersion, attempt).
    assert.equal(body.source, "MANUAL");
    assert.deepEqual(repository.triggerCalls, [
      { userId: USERS.member, projectId: PROJECT_A },
    ]);

    // The route body is empty by design: nothing here lets a caller assert
    // evidence, criteria, or an attempt directly.
    const rejectedExtraField = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_A}/release-assessments`,
      headers: { authorization: `Bearer ${TOKENS.member}` },
      payload: { evidence: [{ kind: "TEST", status: "PASSED" }] },
    });
    assert.equal(rejectedExtraField.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("a user outside the project's workspace cannot trigger or read its assessment", async () => {
  const { app } = await fixture();
  try {
    const triggerResponse = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_A}/release-assessments`,
      headers: { authorization: `Bearer ${TOKENS.outsider}` },
      payload: {},
    });
    assert.equal(triggerResponse.statusCode, 404);
    assert.equal(triggerResponse.json().error.code, "WORKSPACE_ACCESS_DENIED");

    const readResponse = await app.inject({
      method: "GET",
      url: `/v1/release-assessments/${ASSESSMENT_READY}`,
      headers: { authorization: `Bearer ${TOKENS.outsider}` },
    });
    assert.equal(readResponse.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("a workspace member can read an assessment by id, whether READY or BLOCKED", async () => {
  const { app } = await fixture();
  try {
    const ready = await app.inject({
      method: "GET",
      url: `/v1/release-assessments/${ASSESSMENT_READY}`,
      headers: { authorization: `Bearer ${TOKENS.member}` },
    });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().status, "READY");

    const blocked = await app.inject({
      method: "GET",
      url: `/v1/release-assessments/${ASSESSMENT_BLOCKED}`,
      headers: { authorization: `Bearer ${TOKENS.member}` },
    });
    assert.equal(blocked.statusCode, 200);
    assert.equal(blocked.json().status, "BLOCKED");
    assert.deepEqual(blocked.json().issues, [{ code: "MISSING_ACCEPTANCE" }]);
  } finally {
    await app.close();
  }
});

test("no eligible run is reported distinctly from project-not-found", async () => {
  const { app, repository } = await fixture();
  repository.triggerResult = { kind: "no_eligible_run" };
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_A}/release-assessments`,
      headers: { authorization: `Bearer ${TOKENS.member}` },
      payload: {},
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "NO_ELIGIBLE_RUN");
  } finally {
    await app.close();
  }
});

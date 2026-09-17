import assert from "node:assert/strict";
import test from "node:test";

import type {
  CreateDealInput,
  CreateGtmScopeInput,
  CreateProjectInput,
  CreateProspectInput,
  DealStage,
  FileContentInput,
  JsonValue,
  WorkspaceRole,
} from "@atoms/contracts";

import { buildControlApi } from "./app.js";
import type {
  DealRecord,
  GtmScopeRecord,
  ProspectRecord,
} from "./gtm-domain.js";
import type {
  CreateDealResult,
  CreateGtmScopeResult,
  GtmControlRepository,
  GtmScopeAccessRecord,
  UpdateDealStageResult,
} from "./gtm-repository.js";
import type {
  ControlRepository,
  CreateRunWithIdempotencyResult,
  PutProjectFileResult,
  WorkspaceMembershipRecord,
} from "./repository.js";
import type { RunQueue } from "./run-queue.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000601";
const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000602";
const PROJECT_ID = "00000000-0000-4000-8000-000000000603";
const GTM_SCOPE_ID = "00000000-0000-4000-8000-000000000604";
const OTHER_GTM_SCOPE_ID = "00000000-0000-4000-8000-000000000605";
const PROSPECT_ID = "00000000-0000-4000-8000-000000000606";
const OTHER_PROSPECT_ID = "00000000-0000-4000-8000-000000000607";
const DEAL_ID = "00000000-0000-4000-8000-000000000608";
const FIXED_NOW = new Date("2026-09-16T18:00:00.000Z");

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
  async markRunFailed(
    _runId: string,
    _expectedControlVersion: number,
    _error: JsonValue,
  ): Promise<void> {}
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
  async putProjectFile(
    _userId: string,
    _projectId: string,
    _input: FileContentInput,
  ): Promise<PutProjectFileResult> {
    return { kind: "project_not_found" };
  }
  async close(): Promise<void> {}
}

class NoopRunQueue implements RunQueue {
  async enqueue(): Promise<void> {}
  async close(): Promise<void> {}
}

class MemoryGtmRepository implements GtmControlRepository {
  role: WorkspaceRole = "OWNER";
  readonly scopes = new Map<string, GtmScopeRecord>();
  readonly prospects = new Map<string, ProspectRecord>();
  readonly deals = new Map<string, DealRecord>();

  async getWorkspaceMembership(
    _userId: string,
    workspaceId: string,
  ): Promise<{ readonly role: WorkspaceRole } | null> {
    if (workspaceId !== WORKSPACE_ID) return null;
    return { role: this.role };
  }

  async createGtmScope(
    workspaceId: string,
    input: CreateGtmScopeInput,
  ): Promise<CreateGtmScopeResult> {
    if (input.mode === "PROJECT_GTM" && input.projectId !== PROJECT_ID) {
      return { kind: "project_not_found" };
    }
    const scope: GtmScopeRecord = {
      id: GTM_SCOPE_ID,
      workspaceId,
      projectId: input.mode === "PROJECT_GTM" ? (input.projectId ?? null) : null,
      mode: input.mode,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    this.scopes.set(scope.id, scope);
    return { kind: "ok", scope };
  }

  async listGtmScopes(workspaceId: string): Promise<readonly GtmScopeRecord[]> {
    return [...this.scopes.values()].filter((scope) => scope.workspaceId === workspaceId);
  }

  async getGtmScopeAccess(
    _userId: string,
    gtmScopeId: string,
  ): Promise<GtmScopeAccessRecord | null> {
    const scope = this.scopes.get(gtmScopeId);
    if (scope === undefined) return null;
    return { scope, role: this.role };
  }

  async createProspect(
    gtmScopeId: string,
    input: CreateProspectInput,
  ): Promise<ProspectRecord> {
    const prospect: ProspectRecord = {
      id: PROSPECT_ID,
      gtmScopeId,
      companyName: input.companyName,
      companyDomain: input.companyDomain ?? null,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      normalizedEmail: input.contactEmail.trim().toLowerCase(),
      contactTitle: input.contactTitle ?? null,
      industry: input.industry ?? null,
      companySizeHeadcount: input.companySizeHeadcount ?? null,
      useCase: input.useCase,
      fitEvidenceStatus: input.fitEvidenceStatus,
      fitEvidenceNotes: input.fitEvidenceNotes ?? null,
      source: input.source,
      sourceExternalId: input.sourceExternalId ?? null,
      status: "DISCOVERED",
      currentScore: null,
      currentScoreBand: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    this.prospects.set(prospect.id, prospect);
    return prospect;
  }

  async listProspects(gtmScopeId: string): Promise<readonly ProspectRecord[]> {
    return [...this.prospects.values()].filter((p) => p.gtmScopeId === gtmScopeId);
  }

  async getProspect(
    gtmScopeId: string,
    prospectId: string,
  ): Promise<ProspectRecord | null> {
    const prospect = this.prospects.get(prospectId);
    if (prospect === undefined || prospect.gtmScopeId !== gtmScopeId) return null;
    return prospect;
  }

  async createDeal(
    gtmScopeId: string,
    input: CreateDealInput,
    now: Date,
  ): Promise<CreateDealResult> {
    const prospect = this.prospects.get(input.prospectId);
    if (prospect === undefined || prospect.gtmScopeId !== gtmScopeId) {
      return { kind: "prospect_not_found" };
    }
    const stage = input.stage ?? "PROSPECTING";
    const isClosed = stage === "CLOSED_WON" || stage === "CLOSED_LOST";
    const deal: DealRecord = {
      id: DEAL_ID,
      gtmScopeId,
      prospectId: input.prospectId,
      name: input.name,
      stage,
      amountUsdMicros:
        input.amountUsdMicros === undefined ? null : BigInt(input.amountUsdMicros),
      closeDateExpected:
        input.closeDateExpected === undefined ? null : new Date(input.closeDateExpected),
      closedAt: isClosed ? now : null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    this.deals.set(deal.id, deal);
    return { kind: "ok", deal };
  }

  async listDeals(gtmScopeId: string): Promise<readonly DealRecord[]> {
    return [...this.deals.values()].filter((d) => d.gtmScopeId === gtmScopeId);
  }

  async getDeal(gtmScopeId: string, dealId: string): Promise<DealRecord | null> {
    const deal = this.deals.get(dealId);
    if (deal === undefined || deal.gtmScopeId !== gtmScopeId) return null;
    return deal;
  }

  async updateDealStage(
    gtmScopeId: string,
    dealId: string,
    stage: DealStage,
    now: Date,
  ): Promise<UpdateDealStageResult> {
    const existing = this.deals.get(dealId);
    if (existing === undefined || existing.gtmScopeId !== gtmScopeId) {
      return { kind: "not_found" };
    }
    if (existing.stage === "CLOSED_WON" || existing.stage === "CLOSED_LOST") {
      return { kind: "terminal_stage", deal: existing };
    }
    const isClosed = stage === "CLOSED_WON" || stage === "CLOSED_LOST";
    const updated: DealRecord = {
      ...existing,
      stage,
      closedAt: isClosed ? now : existing.closedAt,
    };
    this.deals.set(dealId, updated);
    return { kind: "ok", deal: updated };
  }
}

async function fixture() {
  const repository = new MemoryGtmRepository();
  const app = await buildControlApi({
    repository: new NoopControlRepository(),
    runQueue: new NoopRunQueue(),
    authRequired: false,
    gtmOperations: { repository },
    now: () => FIXED_NOW,
  });
  return { app, repository };
}

async function createScope(app: Awaited<ReturnType<typeof fixture>>["app"]) {
  return app.inject({
    method: "POST",
    url: `/v1/workspaces/${WORKSPACE_ID}/gtm-scopes`,
    payload: { mode: "PLATFORM_GTM" },
  });
}

test("creating a GtmScope requires an administrative role", async () => {
  const { app, repository } = await fixture();
  repository.role = "MEMBER";
  const response = await createScope(app);
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).error.code, "INSUFFICIENT_WORKSPACE_ROLE");
});

test("an OWNER can create a PLATFORM_GTM scope with no projectId", async () => {
  const { app } = await fixture();
  const response = await createScope(app);
  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body);
  assert.equal(body.mode, "PLATFORM_GTM");
  assert.equal(body.projectId, null);
});

test("a PROJECT_GTM scope with no projectId is rejected by contract validation", async () => {
  const { app } = await fixture();
  const response = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${WORKSPACE_ID}/gtm-scopes`,
    payload: { mode: "PROJECT_GTM" },
  });
  assert.equal(response.statusCode, 400);
});

test("creating a Prospect only requires workspace membership, not an administrative role", async () => {
  const { app, repository } = await fixture();
  await createScope(app);
  repository.role = "MEMBER";
  const response = await app.inject({
    method: "POST",
    url: `/v1/gtm-scopes/${GTM_SCOPE_ID}/prospects`,
    payload: {
      companyName: "Acme Inc",
      contactName: "Jordan Rivera",
      contactEmail: "jordan@acme.test",
      useCase: "Self-service internal tooling",
      fitEvidenceStatus: "ASSUMPTION",
      source: "MANUAL",
    },
  });
  assert.equal(response.statusCode, 201);
});

test("creating a Deal only requires workspace membership, not an administrative role", async () => {
  const { app, repository } = await fixture();
  await createScope(app);
  await app.inject({
    method: "POST",
    url: `/v1/gtm-scopes/${GTM_SCOPE_ID}/prospects`,
    payload: {
      companyName: "Acme Inc",
      contactName: "Jordan Rivera",
      contactEmail: "jordan@acme.test",
      useCase: "Self-service internal tooling",
      fitEvidenceStatus: "ASSUMPTION",
      source: "MANUAL",
    },
  });
  repository.role = "MEMBER";
  const response = await app.inject({
    method: "POST",
    url: `/v1/gtm-scopes/${GTM_SCOPE_ID}/deals`,
    payload: { prospectId: PROSPECT_ID, name: "Acme Inc - annual plan" },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.body).stage, "PROSPECTING");
});

test("creating a Deal with a prospectId from a different scope is reported not found", async () => {
  const { app, repository } = await fixture();
  await createScope(app);
  repository.prospects.set(OTHER_PROSPECT_ID, {
    id: OTHER_PROSPECT_ID,
    gtmScopeId: OTHER_GTM_SCOPE_ID,
    companyName: "Other Co",
    companyDomain: null,
    contactName: "Other Contact",
    contactEmail: "other@other.test",
    normalizedEmail: "other@other.test",
    contactTitle: null,
    industry: null,
    companySizeHeadcount: null,
    useCase: "n/a",
    fitEvidenceStatus: "ASSUMPTION",
    fitEvidenceNotes: null,
    source: "MANUAL",
    sourceExternalId: null,
    status: "DISCOVERED",
    currentScore: null,
    currentScoreBand: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  });
  const response = await app.inject({
    method: "POST",
    url: `/v1/gtm-scopes/${GTM_SCOPE_ID}/deals`,
    payload: { prospectId: OTHER_PROSPECT_ID, name: "Cross-scope deal" },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "PROSPECT_NOT_FOUND");
});

test("a deal stage transition into CLOSED_WON sets closedAt", async () => {
  const { app } = await fixture();
  await createScope(app);
  await app.inject({
    method: "POST",
    url: `/v1/gtm-scopes/${GTM_SCOPE_ID}/prospects`,
    payload: {
      companyName: "Acme Inc",
      contactName: "Jordan Rivera",
      contactEmail: "jordan@acme.test",
      useCase: "Self-service internal tooling",
      fitEvidenceStatus: "ASSUMPTION",
      source: "MANUAL",
    },
  });
  await app.inject({
    method: "POST",
    url: `/v1/gtm-scopes/${GTM_SCOPE_ID}/deals`,
    payload: { prospectId: PROSPECT_ID, name: "Acme Inc - annual plan" },
  });

  const response = await app.inject({
    method: "PATCH",
    url: `/v1/gtm-scopes/${GTM_SCOPE_ID}/deals/${DEAL_ID}/stage`,
    payload: { stage: "CLOSED_WON" },
  });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.stage, "CLOSED_WON");
  assert.equal(body.closedAt, FIXED_NOW.toISOString());
});

test("a deal stage transition away from CLOSED_WON is rejected as terminal", async () => {
  const { app } = await fixture();
  await createScope(app);
  await app.inject({
    method: "POST",
    url: `/v1/gtm-scopes/${GTM_SCOPE_ID}/prospects`,
    payload: {
      companyName: "Acme Inc",
      contactName: "Jordan Rivera",
      contactEmail: "jordan@acme.test",
      useCase: "Self-service internal tooling",
      fitEvidenceStatus: "ASSUMPTION",
      source: "MANUAL",
    },
  });
  await app.inject({
    method: "POST",
    url: `/v1/gtm-scopes/${GTM_SCOPE_ID}/deals`,
    payload: { prospectId: PROSPECT_ID, name: "Acme Inc - annual plan" },
  });
  await app.inject({
    method: "PATCH",
    url: `/v1/gtm-scopes/${GTM_SCOPE_ID}/deals/${DEAL_ID}/stage`,
    payload: { stage: "CLOSED_WON" },
  });

  const response = await app.inject({
    method: "PATCH",
    url: `/v1/gtm-scopes/${GTM_SCOPE_ID}/deals/${DEAL_ID}/stage`,
    payload: { stage: "NEGOTIATION" },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).error.code, "DEAL_STAGE_TERMINAL");
});

test("an inaccessible or nonexistent GtmScope is reported not found, never forbidden", async () => {
  const { app } = await fixture();
  const response = await app.inject({
    method: "GET",
    url: `/v1/gtm-scopes/${OTHER_GTM_SCOPE_ID}`,
  });
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "WORKSPACE_ACCESS_DENIED");
});

test("an inaccessible workspace is reported not found for the list route", async () => {
  const { app } = await fixture();
  const response = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${OTHER_WORKSPACE_ID}/gtm-scopes`,
  });
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "WORKSPACE_ACCESS_DENIED");
});

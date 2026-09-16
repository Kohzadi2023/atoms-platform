import assert from "node:assert/strict";
import test from "node:test";

import {
  CrmSyncRecordResponseSchema,
  DealResponseSchema,
  GtmScopeResponseSchema,
  LeadScoreResponseSchema,
  OutreachEventResponseSchema,
  OutreachSequenceResponseSchema,
  ProspectResponseSchema,
  SuppressionEntryResponseSchema,
} from "./gtm.js";

const NOW = "2026-09-16T00:00:00.000Z";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000501";
const PROJECT_ID = "00000000-0000-4000-8000-000000000502";
const GTM_SCOPE_ID = "00000000-0000-4000-8000-000000000503";
const PROSPECT_ID = "00000000-0000-4000-8000-000000000504";
const SEQUENCE_ID = "00000000-0000-4000-8000-000000000505";
const DEAL_ID = "00000000-0000-4000-8000-000000000506";

test("GtmScopeResponse accepts a platform-scoped and a project-scoped record", () => {
  const platform = GtmScopeResponseSchema.parse({
    id: GTM_SCOPE_ID,
    workspaceId: WORKSPACE_ID,
    projectId: null,
    mode: "PLATFORM_GTM",
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(platform.mode, "PLATFORM_GTM");

  const project = GtmScopeResponseSchema.parse({
    ...platform,
    projectId: PROJECT_ID,
    mode: "PROJECT_GTM",
  });
  assert.equal(project.projectId, PROJECT_ID);
});

test("GtmScopeResponse rejects an unknown field", () => {
  assert.throws(() =>
    GtmScopeResponseSchema.parse({
      id: GTM_SCOPE_ID,
      workspaceId: WORKSPACE_ID,
      projectId: null,
      mode: "PLATFORM_GTM",
      createdAt: NOW,
      updatedAt: NOW,
      extra: "not allowed",
    }),
  );
});

function prospect(overrides: Record<string, unknown> = {}) {
  return {
    id: PROSPECT_ID,
    gtmScopeId: GTM_SCOPE_ID,
    companyName: "Acme Inc",
    companyDomain: "acme.test",
    contactName: "Jordan Rivera",
    contactEmail: "jordan@acme.test",
    normalizedEmail: "jordan@acme.test",
    contactTitle: "VP Engineering",
    industry: "Software",
    companySizeHeadcount: 120,
    useCase: "Self-service internal tooling",
    fitEvidenceStatus: "EVIDENCED",
    fitEvidenceNotes: "Matches ICP firmographics from Sophia's market analysis",
    source: "APOLLO",
    sourceExternalId: "apollo-abc123",
    status: "DISCOVERED",
    currentScore: 72,
    currentScoreBand: "WARM",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test("ProspectResponse accepts a complete record", () => {
  const parsed = ProspectResponseSchema.parse(prospect());
  assert.equal(parsed.status, "DISCOVERED");
});

test("ProspectResponse rejects an unknown field", () => {
  assert.throws(() => ProspectResponseSchema.parse(prospect({ extra: "nope" })));
});

test("LeadScoreResponse accepts a scored record", () => {
  const parsed = LeadScoreResponseSchema.parse({
    id: "00000000-0000-4000-8000-000000000507",
    prospectId: PROSPECT_ID,
    score: 72,
    band: "WARM",
    scoringVersion: "v1",
    rationale: { firmographicFit: 0.8, engagementFit: 0.6 },
    computedAt: NOW,
    createdAt: NOW,
  });
  assert.equal(parsed.band, "WARM");
});

test("LeadScoreResponse rejects an unknown field", () => {
  assert.throws(() =>
    LeadScoreResponseSchema.parse({
      id: "00000000-0000-4000-8000-000000000507",
      prospectId: PROSPECT_ID,
      score: 72,
      band: "WARM",
      scoringVersion: "v1",
      rationale: {},
      computedAt: NOW,
      createdAt: NOW,
      extra: "nope",
    }),
  );
});

test("OutreachSequenceResponse accepts a draft sequence", () => {
  const parsed = OutreachSequenceResponseSchema.parse({
    id: SEQUENCE_ID,
    gtmScopeId: GTM_SCOPE_ID,
    name: "Q4 outbound",
    status: "DRAFT",
    steps: [{ ordinal: 1, channel: "EMAIL", templateRef: "intro-v1", waitDays: 0 }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(parsed.status, "DRAFT");
});

test("OutreachSequenceResponse rejects an unknown field", () => {
  assert.throws(() =>
    OutreachSequenceResponseSchema.parse({
      id: SEQUENCE_ID,
      gtmScopeId: GTM_SCOPE_ID,
      name: "Q4 outbound",
      status: "DRAFT",
      steps: [],
      createdAt: NOW,
      updatedAt: NOW,
      extra: "nope",
    }),
  );
});

test("OutreachEventResponse accepts a sent event", () => {
  const parsed = OutreachEventResponseSchema.parse({
    id: "00000000-0000-4000-8000-000000000508",
    sequenceId: SEQUENCE_ID,
    prospectId: PROSPECT_ID,
    stepOrdinal: 1,
    channel: "EMAIL",
    kind: "SENT",
    providerMessageId: "msg-123",
    occurredAt: NOW,
    metadata: null,
    createdAt: NOW,
  });
  assert.equal(parsed.kind, "SENT");
});

test("OutreachEventResponse rejects an unknown field", () => {
  assert.throws(() =>
    OutreachEventResponseSchema.parse({
      id: "00000000-0000-4000-8000-000000000508",
      sequenceId: SEQUENCE_ID,
      prospectId: PROSPECT_ID,
      stepOrdinal: 1,
      channel: "EMAIL",
      kind: "SENT",
      providerMessageId: null,
      occurredAt: NOW,
      metadata: null,
      createdAt: NOW,
      extra: "nope",
    }),
  );
});

test("SuppressionEntryResponse accepts an unsubscribe record", () => {
  const parsed = SuppressionEntryResponseSchema.parse({
    id: "00000000-0000-4000-8000-000000000509",
    gtmScopeId: GTM_SCOPE_ID,
    channel: "EMAIL",
    normalizedIdentifier: "jordan@acme.test",
    reason: "UNSUBSCRIBED",
    createdAt: NOW,
  });
  assert.equal(parsed.reason, "UNSUBSCRIBED");
});

test("SuppressionEntryResponse rejects an unknown field", () => {
  assert.throws(() =>
    SuppressionEntryResponseSchema.parse({
      id: "00000000-0000-4000-8000-000000000509",
      gtmScopeId: GTM_SCOPE_ID,
      channel: "EMAIL",
      normalizedIdentifier: "jordan@acme.test",
      reason: "UNSUBSCRIBED",
      createdAt: NOW,
      extra: "nope",
    }),
  );
});

function crmSyncRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000510",
    gtmScopeId: GTM_SCOPE_ID,
    provider: "HUBSPOT",
    entityType: "CONTACT",
    prospectId: PROSPECT_ID,
    dealId: null,
    externalId: "hs-contact-1",
    status: "SYNCED",
    lastSyncedAt: NOW,
    lastAttemptAt: NOW,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test("CrmSyncRecordResponse accepts a contact sync and a deal sync", () => {
  const contact = CrmSyncRecordResponseSchema.parse(crmSyncRecord());
  assert.equal(contact.entityType, "CONTACT");

  const deal = CrmSyncRecordResponseSchema.parse(
    crmSyncRecord({
      entityType: "DEAL",
      prospectId: null,
      dealId: DEAL_ID,
      externalId: "hs-deal-1",
    }),
  );
  assert.equal(deal.dealId, DEAL_ID);
});

test("CrmSyncRecordResponse rejects a DEAL record that also sets prospectId", () => {
  assert.throws(() =>
    CrmSyncRecordResponseSchema.parse(
      crmSyncRecord({ entityType: "DEAL", dealId: DEAL_ID, prospectId: PROSPECT_ID }),
    ),
  );
});

test("CrmSyncRecordResponse rejects a CONTACT record with no prospectId", () => {
  assert.throws(() =>
    CrmSyncRecordResponseSchema.parse(crmSyncRecord({ prospectId: null })),
  );
});

test("DealResponse accepts a deal with a micros amount serialized as a string", () => {
  const parsed = DealResponseSchema.parse({
    id: DEAL_ID,
    gtmScopeId: GTM_SCOPE_ID,
    prospectId: PROSPECT_ID,
    name: "Acme Inc - annual plan",
    stage: "PROPOSAL",
    amountUsdMicros: "12000000000",
    closeDateExpected: "2026-12-01",
    closedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(parsed.amountUsdMicros, "12000000000");
});

test("DealResponse rejects a non-numeric amountUsdMicros string", () => {
  assert.throws(() =>
    DealResponseSchema.parse({
      id: DEAL_ID,
      gtmScopeId: GTM_SCOPE_ID,
      prospectId: PROSPECT_ID,
      name: "Acme Inc - annual plan",
      stage: "PROPOSAL",
      amountUsdMicros: "not-a-number",
      closeDateExpected: null,
      closedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
});

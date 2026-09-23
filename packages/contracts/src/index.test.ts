import assert from "node:assert/strict";
import test from "node:test";

import {
  ApproveOrphanCleanupInputSchema,
  ApprovalRequiredEventPayloadV1Schema,
  ReleaseBlockedEventPayloadV1Schema,
  ArtifactCreatedEventPayloadV1Schema,
  AttachmentScanJobSchema,
  ContentPackageSchema,
  CustomerSuccessPackageSchema,
  CreateAttachmentUploadIntentInputSchema,
  CreateProjectInputSchema,
  CreateRunHeadersSchema,
  CreateRunInputSchema,
  GetMeResponseSchema,
  GetWorkspaceResponseSchema,
  ListWorkspacesResponseSchema,
  MAX_ATTACHMENT_BYTES,
  DatabaseOperationJobSchema,
  DatabaseReconciliationSummarySchema,
  DatabaseStatusChangedEventPayloadV1Schema,
  FileContentInputSchema,
  PreviewUpdatedEventPayloadV1Schema,
  Phase3ProviderStagingEvidenceSchema,
  PHASE3_PROVIDER_STAGING_EVIDENCE_VERSION,
  PHASE3_VARIABLE_COST_TARGET_CAD_MICROS,
  ProvisionDatabaseInputSchema,
  ProjectFileListResponseSchema,
  RunActionInputSchema,
  RunEventEnvelopeSchema,
  RunJobSchema,
  SandboxReadyEventPayloadV1Schema,
  SeoPackageSchema,
  SandboxValidationProgressEventPayloadV1Schema,
  validateRunEventPayload,
} from "./index.js";

const workspaceId = "d6ac1939-4d53-4a15-8f81-a1b135e0fa32";
const runId = "0cc9979f-6d6a-49d4-a0ec-5c8a82bcb0e3";

test("CreateProjectInput accepts a strict, normalized project contract", () => {
  const result = CreateProjectInputSchema.parse({
    workspaceId,
    name: "Customer Portal",
    slug: "customer-portal",
    description: "A multi-tenant customer portal",
  });

  assert.equal(result.slug, "customer-portal");
  assert.throws(() =>
    CreateProjectInputSchema.parse({
      workspaceId,
      name: "Customer Portal",
      slug: "Customer Portal",
      unexpected: true,
    }),
  );
});

test("RunActionInput constrains commands and concurrency tokens", () => {
  assert.deepEqual(
    RunActionInputSchema.parse({
      action: "pause",
      expectedStatus: "RUNNING",
      expectedControlVersion: 3,
    }),
    {
      action: "pause",
      expectedStatus: "RUNNING",
      expectedControlVersion: 3,
    },
  );
  assert.deepEqual(
    RunActionInputSchema.parse({
      action: "approve",
      expectedStatus: "PAUSED",
      expectedControlVersion: 4,
      approvalScope: "content",
    }),
    {
      action: "approve",
      expectedStatus: "PAUSED",
      expectedControlVersion: 4,
      approvalScope: "content",
    },
  );
  assert.throws(() =>
    RunActionInputSchema.parse({
      action: "approve",
      expectedStatus: "PAUSED",
      expectedControlVersion: 4,
    }),
  );
  assert.throws(() =>
    RunActionInputSchema.parse({
      action: "resume",
      approvalScope: "plan",
    }),
  );
  assert.throws(() => RunActionInputSchema.parse({ action: "delete" }));
});

test("run creation headers share the API idempotency contract", () => {
  assert.deepEqual(
    CreateRunHeadersSchema.parse({
      "idempotency-key": "run-request-2026-08-09",
    }),
    { "idempotency-key": "run-request-2026-08-09" },
  );
  assert.throws(() =>
    CreateRunHeadersSchema.parse({ "idempotency-key": "short" }),
  );
});

test("attachment contracts enforce fixed MIME, size, count, and queue fencing", () => {
  assert.deepEqual(
    CreateAttachmentUploadIntentInputSchema.parse({
      fileName: "brief.pdf",
      contentType: "application/pdf",
      sizeBytes: MAX_ATTACHMENT_BYTES,
    }),
    {
      fileName: "brief.pdf",
      contentType: "application/pdf",
      sizeBytes: MAX_ATTACHMENT_BYTES,
    },
  );
  assert.throws(() =>
    CreateAttachmentUploadIntentInputSchema.parse({
      fileName: "../secret.txt",
      contentType: "text/plain",
      sizeBytes: 10,
    }),
  );
  assert.throws(() =>
    CreateAttachmentUploadIntentInputSchema.parse({
      fileName: "archive.zip",
      contentType: "application/zip",
      sizeBytes: 10,
    }),
  );
  assert.equal(
    AttachmentScanJobSchema.parse({
      attachmentId: "00000000-0000-4000-8000-000000000099",
      scanVersion: 2,
    }).scanVersion,
    2,
  );
});

test("CreateRunInput snapshots at most five unique attachment IDs", () => {
  assert.deepEqual(CreateRunInputSchema.parse({ prompt: "Build it" }), {
    prompt: "Build it",
    attachmentIds: [],
  });
  const id = "00000000-0000-4000-8000-000000000099";
  assert.throws(() =>
    CreateRunInputSchema.parse({ prompt: "Build it", attachmentIds: [id, id] }),
  );
});

test("FileContentInput rejects traversal and stale-version shapes", () => {
  assert.equal(
    FileContentInputSchema.parse({
      filePath: "app/api/route.ts",
      content: "export const runtime = 'nodejs';",
      expectedVersion: 2,
    }).expectedVersion,
    2,
  );
  assert.throws(() =>
    FileContentInputSchema.parse({
      filePath: "../secrets.env",
      content: "secret",
      expectedVersion: 0,
    }),
  );
});

test("ProjectFileListResponse exposes latest revision metadata without content", () => {
  const item = {
    id: "00000000-0000-4000-8000-000000000010",
    projectId: "00000000-0000-4000-8000-000000000011",
    filePath: "app/page.tsx",
    version: 2,
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:01:00.000Z",
  };
  assert.equal(ProjectFileListResponseSchema.parse({ items: [item] }).items[0]?.version, 2);
  assert.throws(() =>
    ProjectFileListResponseSchema.parse({
      items: [{ ...item, content: "must remain opt-in" }],
    }),
  );
});

test("identity contracts expose only strict user and membership summaries", () => {
  const workspace = {
    id: "00000000-0000-4000-8000-000000000101",
    name: "Atoms Workspace",
    slug: "atoms-workspace",
  };

  const me = GetMeResponseSchema.parse({
    userId: "user-123",
    subject: "user-123",
    memberships: [{ workspace, role: "ADMIN" }],
  });
  assert.equal(me.memberships[0]?.role, "ADMIN");

  const workspaces = ListWorkspacesResponseSchema.parse({
    items: [workspace],
  });
  assert.equal(workspaces.items.length, 1);

  const membership = GetWorkspaceResponseSchema.parse({
    workspace,
    role: "OWNER",
  });
  assert.equal(membership.role, "OWNER");

  assert.throws(() =>
    GetMeResponseSchema.parse({
      userId: "user-123",
      subject: "user-123",
      memberships: [{ workspace, role: "MEMBER", token: "secret" }],
    }),
  );
});

test("RunEventEnvelope enforces deterministic sequence and JSON payloads", () => {
  const event = RunEventEnvelopeSchema.parse({
    sequence: 7,
    runId,
    eventType: "code_generated",
    payload: { paths: ["app/page.tsx"], bytes: 1_024 },
    occurredAt: "2026-07-31T18:30:00.000Z",
  });

  assert.equal(event.sequence, 7);
  assert.throws(() => RunEventEnvelopeSchema.parse({ ...event, sequence: 1.5 }));
  assert.throws(() =>
    RunEventEnvelopeSchema.parse({ ...event, payload: { value: undefined } }),
  );
});

test("RunJob defines the durable Control API to worker queue contract", () => {
  const runId = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(
    RunJobSchema.parse({
      runId,
      command: "approve",
      controlVersion: 4,
      reason: "Continue after approval",
      approvalScope: "plan",
    }),
    {
      runId,
      command: "approve",
      controlVersion: 4,
      reason: "Continue after approval",
      approvalScope: "plan",
    },
  );
  assert.throws(() =>
    RunJobSchema.parse({
      runId,
      command: "pause",
      controlVersion: 4,
    }),
  );
});

test("Phase 2 SSE payloads are versioned and reject provider credentials", () => {
  const sandboxSessionId = "00000000-0000-4000-8000-000000000041";
  assert.equal(
    SandboxReadyEventPayloadV1Schema.parse({
      version: "v1",
      sandboxSessionId,
      status: "VALIDATING",
    }).status,
    "VALIDATING",
  );
  assert.equal(
    SandboxValidationProgressEventPayloadV1Schema.parse({
      version: "v1",
      phase: "sandbox-validation",
      sandboxSessionId,
      ordinal: 1,
      step: "install",
      status: "SUCCEEDED",
      exitCode: 0,
      durationMs: 25,
      stdout: "installed",
      stderr: "",
    }).step,
    "install",
  );
  // G3 (docs/adr/production-execution-gate.md): every ValidationStepName the
  // sandbox runner can report (packages/sandbox-provider/src/project-validation-runner.ts)
  // must parse here, or recording it throws inside the same DB transaction
  // that persists the step -- silently defeating those steps' non-blocking design.
  for (const step of ["db-start", "db-migrate", "db-seed", "acceptance"] as const) {
    assert.equal(
      SandboxValidationProgressEventPayloadV1Schema.parse({
        version: "v1",
        phase: "sandbox-validation",
        sandboxSessionId,
        ordinal: 1,
        step,
        status: "SUCCEEDED",
        exitCode: 0,
        durationMs: 25,
        stdout: "",
        stderr: "",
      }).step,
      step,
    );
  }
  assert.throws(() =>
    PreviewUpdatedEventPayloadV1Schema.parse({
      version: "v1",
      previewSessionId: sandboxSessionId,
      status: "READY",
      url: "https://signed.preview.example.test/",
      expiresAt: "2026-08-01T12:15:00.000Z",
      providerToken: "must-not-cross-the-event-boundary",
    }),
  );
});

test("Phase 3 database contracts require approval and deterministic queue identity", () => {
  const migrationArtifactId = "00000000-0000-4000-8000-000000000042";
  const databaseInstanceId = "00000000-0000-4000-8000-000000000043";
  const operationId = "00000000-0000-4000-8000-000000000044";
  assert.equal(
    ProvisionDatabaseInputSchema.parse({
      provider: "SUPABASE",
      region: "americas",
      migrationArtifactId,
      confirmation: "PROVISION_DATABASE",
    }).approveDestructiveChanges,
    false,
  );
  assert.throws(() =>
    ProvisionDatabaseInputSchema.parse({
      provider: "SUPABASE",
      region: "americas",
      migrationArtifactId,
      confirmation: "yes",
    }),
  );
  assert.equal(
    DatabaseOperationJobSchema.parse({
      operationId,
      databaseInstanceId,
      command: "provision",
    }).operationVersion,
    0,
  );
  assert.equal(
    DatabaseStatusChangedEventPayloadV1Schema.parse({
      version: "v1",
      integration: "generated-database",
      databaseInstanceId,
      operationId,
      operationVersion: 1,
      provider: "SUPABASE",
      status: "MIGRATING",
    }).operationVersion,
    1,
  );
});

test("Phase 3 reconciliation contracts fail closed around orphan deletion", () => {
  assert.deepEqual(
    DatabaseReconciliationSummarySchema.parse({
      recoveredOperations: 2,
      exhaustedOperations: 1,
      missingResources: 1,
      orphanCandidates: 3,
      cleanedResources: 0,
    }),
    {
      recoveredOperations: 2,
      exhaustedOperations: 1,
      missingResources: 1,
      orphanCandidates: 3,
      cleanedResources: 0,
    },
  );
  assert.throws(() =>
    ApproveOrphanCleanupInputSchema.parse({
      findingId: "00000000-0000-4000-8000-000000000045",
      externalId: "orphan-resource",
      approvedBy: "operator@example.test",
      confirmation: "yes",
    }),
  );
});

test("Phase 3 staging evidence is complete, cost-bounded, and credential-free", () => {
  const gateNames = [
    "provider_inventory_before",
    "provider_provision",
    "provider_health",
    "e2b_install",
    "database_migrate",
    "database_seed",
    "database_connectivity",
    "provider_cleanup",
    "provider_inventory_after",
    "variable_cost",
  ] as const;
  const evidence = {
    version: PHASE3_PROVIDER_STAGING_EVIDENCE_VERSION,
    scenarioId: "00000000-0000-4000-8000-000000000046",
    changeTicket: "CHG-2046",
    environment: "staging",
    result: "PASSED",
    startedAt: "2026-08-01T22:00:00.000Z",
    completedAt: "2026-08-01T22:05:00.000Z",
    externalResourceFingerprint:
      "d".repeat(64),
    managedResourcesBefore: 2,
    managedResourcesAfter: 2,
    createdResources: 1,
    deletedResources: 1,
    workflowRun: { repository: "atoms/platform", runId: "100", runAttempt: 1, commitSha: "a".repeat(40) },
    approvedBudgetCadMicros: 1_000_000,
    measuredVariableCostCadMicros: 750_000,
    costMeasurement: {
      recordedAt: "2026-08-01T23:00:00.000Z",
      recordedBy: "operator",
      measurementSourceSha256: "a".repeat(64),
      sourceEvidenceSha256: "b".repeat(64),
    },
    variableCostTargetCadMicros: PHASE3_VARIABLE_COST_TARGET_CAD_MICROS,
    gates: gateNames.map((name) => ({
      name,
      status: "PASSED" as const,
      durationMs: 1,
      details: {},
    })),
    errors: [],
  };

  assert.equal(
    Phase3ProviderStagingEvidenceSchema.parse(evidence).result,
    "PASSED",
  );
  assert.throws(() =>
    Phase3ProviderStagingEvidenceSchema.parse({
      ...evidence,
      gates: evidence.gates.map((gate, index) =>
        index === 0
          ? { ...gate, details: { url: "postgresql://user:secret@example.test/db" } }
          : gate,
      ),
    }),
  );
  assert.throws(() =>
    Phase3ProviderStagingEvidenceSchema.parse({
      ...evidence,
      measuredVariableCostCadMicros: 4_000_001,
    }),
  );
  for (const changed of [
    { measuredVariableCostCadMicros: null, costMeasurement: null },
    { measuredVariableCostCadMicros: 1_000_001 },
    { managedResourcesAfter: 3 },
    { costMeasurement: { ...evidence.costMeasurement, recordedAt: evidence.startedAt } },
  ]) {
    assert.equal(Phase3ProviderStagingEvidenceSchema.safeParse({ ...evidence, ...changed }).success, false);
  }
  const pending = {
    ...evidence, result: "AWAITING_COST", measuredVariableCostCadMicros: null, costMeasurement: null,
    gates: evidence.gates.map((gate) => gate.name === "variable_cost" ? { ...gate, status: "PENDING" } : gate),
  };
  assert.equal(Phase3ProviderStagingEvidenceSchema.parse(pending).result, "AWAITING_COST");
  assert.equal(Phase3ProviderStagingEvidenceSchema.safeParse({ ...pending, deletedResources: 0 }).success, false);
  assert.equal(Phase3ProviderStagingEvidenceSchema.safeParse({ ...pending, result: "PASSED" }).success, false);
});

test("SEO_PACKAGE v1 accepts sitemap, robots, route metadata, and findings", () => {
  const parsed = SeoPackageSchema.parse({
    version: "v1",
    sitemapXml: "<?xml version=\"1.0\"?><urlset></urlset>",
    robotsTxt: "User-agent: *\nAllow: /",
    routeMetadata: [
      {
        routePath: "/",
        title: "Acme Booking",
        description: "Book appointments with Acme.",
        canonicalUrl: "https://acme.example/",
      },
    ],
    findings: [
      {
        severity: "INFO",
        subject: "metadata coverage",
        recommendation: "Add metadata for all public routes",
      },
    ],
  });

  assert.equal(parsed.routeMetadata[0]?.routePath, "/");
});

test("SEO_PACKAGE rejects duplicate route metadata paths", () => {
  assert.throws(() =>
    SeoPackageSchema.parse({
      version: "v1",
      sitemapXml: "<urlset></urlset>",
      robotsTxt: "User-agent: *\nAllow: /",
      routeMetadata: [
        {
          routePath: "/pricing",
          title: "Pricing",
          description: "Pricing page",
          canonicalUrl: "https://acme.example/pricing",
        },
        {
          routePath: "/pricing",
          title: "Pricing duplicate",
          description: "Duplicate route",
          canonicalUrl: "https://acme.example/pricing",
        },
      ],
      findings: [],
    }),
  );
});

test("CONTENT_PACKAGE v1 accepts audience, value props, CTAs, ads, and claims", () => {
  const parsed = ContentPackageSchema.parse({
    version: "v1",
    audience: "Technical founders launching MVPs",
    valuePropositions: [
      "Ship a usable product quickly",
      "Retain full source ownership",
    ],
    ctaVariants: [
      {
        id: "cta-primary",
        headline: "Launch your MVP this week",
        body: "Generate a full-stack baseline and iterate with confidence.",
        ctaLabel: "Start building",
      },
    ],
    adVariants: [
      {
        channel: "SEARCH",
        headline: "AI MVP generator",
        body: "From prompt to deployable app with source ownership.",
        ctaLabel: "Try now",
      },
    ],
    claimsRequiringEvidence: [
      {
        claim: "Cuts launch time by 60%.",
        evidenceStatus: "REQUIRED",
        notes: "Needs cohort benchmark evidence",
      },
    ],
  });

  assert.equal(parsed.ctaVariants[0]?.id, "cta-primary");
});

test("CONTENT_PACKAGE rejects duplicate CTA variant IDs", () => {
  assert.throws(() =>
    ContentPackageSchema.parse({
      version: "v1",
      audience: "Agencies",
      valuePropositions: ["Deliver client portals faster"],
      ctaVariants: [
        {
          id: "cta-1",
          headline: "Variant one",
          body: "Body one",
          ctaLabel: "Try",
        },
        {
          id: "cta-1",
          headline: "Variant two",
          body: "Body two",
          ctaLabel: "Start",
        },
      ],
      adVariants: [],
      claimsRequiringEvidence: [],
    }),
  );
});

test("CUSTOMER_SUCCESS_PACKAGE v1 accepts onboarding, activation, health, and retention data", () => {
  const parsed = CustomerSuccessPackageSchema.parse({
    version: "v1",
    onboardingMilestones: [
      {
        id: "ms-kickoff",
        name: "Kickoff call",
        description: "Introduce the account team and confirm success criteria.",
        owner: "CUSTOMER_SUCCESS",
        status: "COMPLETED",
        targetDate: "2026-09-01",
      },
    ],
    activationMilestones: [
      {
        id: "am-first-value",
        milestoneName: "First workspace deployed",
        definitionOfFirstValue: "Customer deploys their first generated project.",
        achieved: true,
        achievedAt: "2026-09-05T12:00:00.000Z",
        evidenceStatus: "EVIDENCED",
      },
    ],
    healthSignals: [
      {
        id: "hs-usage",
        signal: "Weekly active usage",
        severity: "HEALTHY",
        observedEvidence: "Customer has logged in and run a project every week since onboarding.",
        recommendation: "Continue standard check-in cadence.",
      },
    ],
    churnRisk: {
      riskLevel: "LOW",
      primaryDrivers: [],
      mitigationPlan: [],
    },
    retentionProposals: [
      {
        id: "rp-expansion",
        type: "EXPANSION",
        rationale: "Usage has grown beyond the current plan's included credits.",
        proposedAction: "Offer an upgrade to the next plan tier.",
        requiresApproval: true,
        approvalReason: "BILLING_CHANGE",
      },
    ],
  });

  assert.equal(parsed.churnRisk.riskLevel, "LOW");
  assert.equal(parsed.retentionProposals[0]?.requiresApproval, true);
});

test("CUSTOMER_SUCCESS_PACKAGE rejects duplicate health signal IDs", () => {
  assert.throws(() =>
    CustomerSuccessPackageSchema.parse({
      version: "v1",
      onboardingMilestones: [
        {
          id: "ms-kickoff",
          name: "Kickoff call",
          description: "Introduce the account team.",
          owner: "CUSTOMER_SUCCESS",
          status: "COMPLETED",
          targetDate: null,
        },
      ],
      activationMilestones: [
        {
          id: "am-first-value",
          milestoneName: "First workspace deployed",
          definitionOfFirstValue: "Customer deploys their first project.",
          achieved: false,
          achievedAt: null,
          evidenceStatus: "ASSUMPTION",
        },
      ],
      healthSignals: [
        {
          id: "hs-usage",
          signal: "Weekly active usage",
          severity: "HEALTHY",
          observedEvidence: "Regular logins observed.",
          recommendation: "Maintain cadence.",
        },
        {
          id: "hs-usage",
          signal: "Support ticket volume",
          severity: "AT_RISK",
          observedEvidence: "Ticket volume increased threefold.",
          recommendation: "Schedule a health review.",
        },
      ],
      churnRisk: { riskLevel: "MEDIUM", primaryDrivers: [], mitigationPlan: [] },
      retentionProposals: [],
    }),
  );
});

test("artifact.created payload requires typed v1 event fields", () => {
  const payload = ArtifactCreatedEventPayloadV1Schema.parse({
    version: "v1",
    taskId: "00000000-0000-4000-8000-000000000120",
    agent: "Sarah",
    artifactType: "seo-package",
  });
  assert.equal(payload.agent, "Sarah");
  assert.throws(() =>
    ArtifactCreatedEventPayloadV1Schema.parse({
      version: "v1",
      taskId: "00000000-0000-4000-8000-000000000121",
      agent: "Sarah",
      artifactType: "unknown-artifact",
    }),
  );

  const customerSuccessPayload = ArtifactCreatedEventPayloadV1Schema.parse({
    version: "v1",
    taskId: "00000000-0000-4000-8000-000000000125",
    agent: "CustomerSuccess",
    artifactType: "customersuccess-output",
  });
  assert.equal(customerSuccessPayload.agent, "CustomerSuccess");
});

test("validateRunEventPayload dispatches by event type", () => {
  const artifact = validateRunEventPayload("artifact.created", {
    version: "v1",
    taskId: "00000000-0000-4000-8000-000000000122",
    agent: "David",
    artifactType: "david-output",
    migrationArtifactId: "00000000-0000-4000-8000-000000000123",
  });
  assert.equal(
    (artifact as { artifactType: string }).artifactType,
    "david-output",
  );

  const legacyArtifact = validateRunEventPayload("artifact.created", {
    taskId: "00000000-0000-4000-8000-000000000124",
    agent: "David",
    artifactType: "david-output",
  });
  assert.equal(
    (legacyArtifact as { version: string }).version,
    "v1",
  );

  const legacyApproval = validateRunEventPayload("approval.required", {
    reason: "Approve content variants before applying copy changes",
  });
  assert.deepEqual(
    ApprovalRequiredEventPayloadV1Schema.parse(legacyApproval),
    {
      version: "v1",
      scope: "content",
      reason: "Approve content variants before applying copy changes",
    },
  );
});

test("release assessment events are additive and dispatch to their own schemas", () => {
  const started = validateRunEventPayload("release.assessment_started", {
    version: "v1",
    assessmentId: "00000000-0000-4000-8000-000000000200",
    attempt: 1,
  });
  assert.deepEqual(started, {
    version: "v1",
    assessmentId: "00000000-0000-4000-8000-000000000200",
    attempt: 1,
  });

  const ready = validateRunEventPayload("release.ready", {
    version: "v1",
    assessmentId: "00000000-0000-4000-8000-000000000201",
    status: "READY",
    checkCount: 9,
    criterionCount: 2,
  });
  assert.equal((ready as { status: string }).status, "READY");

  const blocked = validateRunEventPayload("release.blocked", {
    version: "v1",
    assessmentId: "00000000-0000-4000-8000-000000000202",
    status: "BLOCKED",
    issueCount: 3,
  });
  assert.equal((blocked as { status: string }).status, "BLOCKED");

  // A READY payload can never be reported through the blocked schema or
  // vice versa -- the discriminant is enforced at the type level, not just
  // by convention.
  assert.throws(() =>
    ReleaseBlockedEventPayloadV1Schema.parse({
      version: "v1",
      assessmentId: "00000000-0000-4000-8000-000000000203",
      status: "READY",
      issueCount: 0,
    }),
  );

  // Existing event types (e.g. run.completed) are untouched by this
  // additive change and still fall through to the generic JSON schema.
  assert.deepEqual(
    validateRunEventPayload("run.completed", { completedAt: "2026-09-14T00:00:00.000Z" }),
    { completedAt: "2026-09-14T00:00:00.000Z" },
  );
});

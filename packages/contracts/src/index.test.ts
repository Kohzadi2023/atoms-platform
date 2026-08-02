import assert from "node:assert/strict";
import test from "node:test";

import {
  ApproveOrphanCleanupInputSchema,
  CreateProjectInputSchema,
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
  SandboxValidationProgressEventPayloadV1Schema,
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
  assert.throws(() => RunActionInputSchema.parse({ action: "delete" }));
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
      command: "resume",
      controlVersion: 4,
      reason: "Continue after approval",
    }),
    {
      runId,
      command: "resume",
      controlVersion: 4,
      reason: "Continue after approval",
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
    measuredVariableCostCadMicros: 750_000,
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
});

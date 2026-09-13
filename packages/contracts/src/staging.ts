import { z } from "zod";

import { JsonValueSchema } from "./json.js";

export const PHASE3_PROVIDER_STAGING_EVIDENCE_VERSION =
  "phase3-provider-staging.v2" as const;
export const PHASE3_VARIABLE_COST_TARGET_CAD_MICROS = 4_000_000 as const;

export const Phase3StagingGateNameSchema = z.enum([
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
]);
export type Phase3StagingGateName = z.infer<
  typeof Phase3StagingGateNameSchema
>;

export const Phase3StagingGateEvidenceSchema = z
  .object({
    name: Phase3StagingGateNameSchema,
    status: z.enum(["PASSED", "FAILED", "PENDING"]),
    durationMs: z.number().int().nonnegative(),
    details: JsonValueSchema,
  })
  .strict();

export type Phase3StagingGateEvidence = z.infer<
  typeof Phase3StagingGateEvidenceSchema
>;

const Phase3StagingErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/),
    message: z.string().trim().min(1).max(1_000),
  })
  .strict();

const expectedGateNames = Phase3StagingGateNameSchema.options;

export const Phase3WorkflowRunSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  runId: z.string().regex(/^[1-9]\d*$/),
  runAttempt: z.number().int().positive().safe(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();

export const Phase3CostMeasurementSchema = z.object({
  recordedAt: z.string().datetime({ offset: true }),
  recordedBy: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/),
  measurementSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const Phase3ProviderStagingEvidenceSchema = z
  .object({
    version: z.literal(PHASE3_PROVIDER_STAGING_EVIDENCE_VERSION),
    scenarioId: z.string().uuid(),
    changeTicket: z
      .string()
      .trim()
      .min(1)
      .max(191)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
    environment: z.literal("staging"),
    result: z.enum(["PASSED", "FAILED", "AWAITING_COST"]),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    externalResourceFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    managedResourcesBefore: z.number().int().nonnegative(),
    managedResourcesAfter: z.number().int().nonnegative(),
    createdResources: z.number().int().nonnegative().max(1),
    deletedResources: z.number().int().nonnegative().max(1),
    workflowRun: Phase3WorkflowRunSchema.nullable(),
    approvedBudgetCadMicros: z.number().int().nonnegative().safe(),
    measuredVariableCostCadMicros: z.number().int().nonnegative().safe().nullable(),
    costMeasurement: Phase3CostMeasurementSchema.nullable(),
    variableCostTargetCadMicros: z.literal(
      PHASE3_VARIABLE_COST_TARGET_CAD_MICROS,
    ),
    gates: z.array(Phase3StagingGateEvidenceSchema).length(
      expectedGateNames.length,
    ),
    errors: z.array(Phase3StagingErrorSchema).max(20),
  })
  .strict()
  .superRefine((evidence, context) => {
    const observedNames = new Set(
      evidence.gates.map((gate) => gate.name),
    );
    for (const name of expectedGateNames) {
      if (!observedNames.has(name)) {
        context.addIssue({
          code: "custom",
          path: ["gates"],
          message: `missing staging evidence gate: ${name}`,
        });
      }
    }
    if (observedNames.size !== evidence.gates.length) {
      context.addIssue({
        code: "custom",
        path: ["gates"],
        message: "staging evidence gate names must be unique",
      });
    }

    const serialized = JSON.stringify(evidence);
    if (
      /postgres(?:ql)?:\/\//iu.test(serialized) ||
      /authorization["']?\s*:\s*["']?bearer\s/iu.test(serialized) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(serialized)
    ) {
      context.addIssue({
        code: "custom",
        message: "staging evidence contains credential-shaped material",
      });
    }

    const costGate = evidence.gates.find((gate) => gate.name === "variable_cost");
    const hasMeasurement = evidence.measuredVariableCostCadMicros !== null;
    if (hasMeasurement !== (evidence.costMeasurement !== null)) {
      context.addIssue({ code: "custom", message: "cost and its measurement provenance must be recorded together" });
    }
    if (Date.parse(evidence.completedAt) < Date.parse(evidence.startedAt)) {
      context.addIssue({ code: "custom", message: "completion must follow the scenario start" });
    }
    if (evidence.costMeasurement !== null && (
      evidence.workflowRun === null ||
      Date.parse(evidence.costMeasurement.recordedAt) < Date.parse(evidence.completedAt)
    )) {
      context.addIssue({ code: "custom", message: "cost must be bound to a workflow run and recorded after the scenario" });
    }
    if (costGate?.status === "PASSED" && !hasMeasurement) {
      context.addIssue({ code: "custom", message: "the cost gate cannot pass without an actual measurement" });
    }
    if (evidence.result === "AWAITING_COST" && (
      hasMeasurement || evidence.costMeasurement !== null || costGate?.status !== "PENDING"
    )) {
      context.addIssue({ code: "custom", message: "awaiting-cost evidence must have an unmeasured pending cost gate" });
    }
    if (evidence.result === "PASSED" || evidence.result === "AWAITING_COST") {
      if (evidence.approvedBudgetCadMicros <= 0 || evidence.approvedBudgetCadMicros > evidence.variableCostTargetCadMicros) {
        context.addIssue({ code: "custom", message: "approved budget must be positive and no greater than the Phase 3 target" });
      }
      if (evidence.managedResourcesBefore !== evidence.managedResourcesAfter) {
        context.addIssue({ code: "custom", message: "provider inventory must be restored" });
      }
      if (evidence.externalResourceFingerprint === null) {
        context.addIssue({
          code: "custom",
          path: ["externalResourceFingerprint"],
          message: "passed evidence requires a resource fingerprint",
        });
      }
      if (
        evidence.createdResources !== 1 ||
        evidence.deletedResources !== 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["createdResources"],
          message: "passed evidence requires exactly one created and deleted resource",
        });
      }
      if (evidence.errors.length !== 0) {
        context.addIssue({
          code: "custom",
          path: ["errors"],
          message: "passed evidence cannot contain errors",
        });
      }
      if (evidence.gates.some((gate) => gate.name !== "variable_cost" && gate.status !== "PASSED")) {
        context.addIssue({
          code: "custom",
          path: ["gates"],
          message: "every lifecycle gate must pass",
        });
      }
      if (evidence.result === "PASSED" && (
        evidence.measuredVariableCostCadMicros === null ||
        evidence.costMeasurement === null || costGate?.status !== "PASSED" ||
        evidence.measuredVariableCostCadMicros > evidence.approvedBudgetCadMicros ||
        evidence.measuredVariableCostCadMicros > evidence.variableCostTargetCadMicros
      )) {
        context.addIssue({
          code: "custom",
          path: ["measuredVariableCostCadMicros"],
          message: "passed evidence requires a measured cost within the approved budget and Phase 3 target",
        });
      }
    }
  });

export type Phase3ProviderStagingEvidence = z.infer<
  typeof Phase3ProviderStagingEvidenceSchema
>;

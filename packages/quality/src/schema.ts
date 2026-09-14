import { z } from "zod";

export const BASELINE_CHECKS = ["LINT", "TYPECHECK", "TEST", "BUILD"] as const;
export const CheckKindSchema = z.enum([
  ...BASELINE_CHECKS,
  "REGRESSION", "E2E", "ACCESSIBILITY", "PERFORMANCE", "SECURITY",
]);
export type CheckKind = z.infer<typeof CheckKindSchema>;

export const QualityScopeSchema = z.object({
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  controlVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  attempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type QualityScope = z.infer<typeof QualityScopeSchema>;

const CriterionIdSchema = z.string().regex(/^US-[0-9]{3}:[1-9][0-9]?$/);
export const AcceptanceSnapshotSchema = z.object({
  taskId: z.string().uuid(),
  scope: QualityScopeSchema,
  criteria: z.array(z.object({
    id: CriterionIdSchema,
    text: z.string().trim().min(1).max(4_000),
  }).strict()).min(1).max(1_000),
}).strict().refine(
  (value) => new Set(value.criteria.map((criterion) => criterion.id)).size === value.criteria.length,
  "Acceptance criterion IDs must be unique",
);
export type AcceptanceSnapshot = z.infer<typeof AcceptanceSnapshotSchema>;

export const EvidenceStatusSchema = z.enum(["PASSED", "FAILED", "SKIPPED", "ERROR"]);
export const QualityEvidenceSchema = z.object({
  id: z.string().uuid(),
  sourceArtifactId: z.string().uuid(),
  scope: QualityScopeSchema,
  kind: z.enum([...CheckKindSchema.options, "ACCEPTANCE"]),
  status: EvidenceStatusSchema,
  completedAt: z.string().datetime({ offset: true }),
  acceptanceTaskId: z.string().uuid().nullable(),
  criterionIds: z.array(CriterionIdSchema).max(1_000),
}).strict().superRefine((value, context) => {
  if (value.kind === "ACCEPTANCE") {
    if (value.acceptanceTaskId === null || value.criterionIds.length === 0) {
      context.addIssue({ code: "custom", message: "Acceptance evidence requires a task and criteria" });
    }
  } else if (value.acceptanceTaskId !== null || value.criterionIds.length !== 0) {
    context.addIssue({ code: "custom", message: "Check success alone cannot attest acceptance criteria" });
  }
  if (new Set(value.criterionIds).size !== value.criterionIds.length) {
    context.addIssue({ code: "custom", message: "Criterion references must be unique" });
  }
});
export type QualityEvidence = z.infer<typeof QualityEvidenceSchema>;

export const QualityPolicySchema = z.object({
  requiredChecks: z.array(CheckKindSchema).min(BASELINE_CHECKS.length).max(CheckKindSchema.options.length),
  maxEvidenceAgeSeconds: z.number().int().min(1).max(604_800),
}).strict().refine(
  (value) => BASELINE_CHECKS.every((kind) => value.requiredChecks.includes(kind)) &&
    new Set(value.requiredChecks).size === value.requiredChecks.length,
  "Policy must include each baseline check and cannot contain duplicates",
);
export type QualityPolicy = z.infer<typeof QualityPolicySchema>;

/** Full default policy. Narrower trusted policies must still include all baseline checks. */
export const STANDARD_RELEASE_POLICY = Object.freeze({
  requiredChecks: Object.freeze([...CheckKindSchema.options]),
  maxEvidenceAgeSeconds: 86_400,
});

export const QualityEvaluationInputSchema = z.object({
  scope: QualityScopeSchema,
  evaluatedAt: z.string().datetime({ offset: true }),
  policy: QualityPolicySchema,
  acceptance: AcceptanceSnapshotSchema.nullable(),
  evidence: z.array(QualityEvidenceSchema).max(2_000),
}).strict();
export type QualityEvaluationInput = z.infer<typeof QualityEvaluationInputSchema>;

export const QualityIssueCodeSchema = z.enum([
  "MISSING_ACCEPTANCE", "ACCEPTANCE_SCOPE_MISMATCH", "DUPLICATE_EVIDENCE",
  "EVIDENCE_SCOPE_MISMATCH", "EVIDENCE_FROM_FUTURE", "EVIDENCE_TOO_OLD",
  "ACCEPTANCE_TASK_MISMATCH", "UNKNOWN_CRITERION", "EVIDENCE_NOT_PASSED",
  "MISSING_CHECK", "MISSING_CRITERION_EVIDENCE",
]);
export const QualityIssueSchema = z.object({
  code: QualityIssueCodeSchema,
  evidenceId: z.string().uuid().optional(),
  check: CheckKindSchema.optional(),
  criterionId: CriterionIdSchema.optional(),
}).strict();
export type QualityIssue = z.infer<typeof QualityIssueSchema>;

const CoverageSchema = z.object({
  status: z.enum(["PASSED", "BLOCKED"]),
  evidenceIds: z.array(z.string().uuid()).max(2_000),
});
export const ReleaseAssessmentSchema = z.object({
  schemaVersion: z.literal("quality.assessment.v1"),
  mode: z.literal("OBSERVE_ONLY"),
  scope: QualityScopeSchema,
  evaluatedAt: z.string().datetime({ offset: true }),
  policy: QualityPolicySchema,
  status: z.enum(["READY", "BLOCKED"]),
  acceptanceTaskId: z.string().uuid().nullable(),
  checks: z.array(CoverageSchema.extend({ kind: CheckKindSchema }).strict()).max(9),
  traceToAcceptance: z.array(CoverageSchema.extend({ criterionId: CriterionIdSchema }).strict()).max(1_000),
  issues: z.array(QualityIssueSchema),
}).strict().superRefine((value, context) => {
  if ((value.status === "READY") !== (value.issues.length === 0)) {
    context.addIssue({ code: "custom", message: "Decision and issues disagree" });
  }
  if (value.status === "READY" && (
    value.acceptanceTaskId === null || value.traceToAcceptance.length === 0 ||
    value.checks.length !== value.policy.requiredChecks.length ||
    new Set(value.checks.map((check) => check.kind)).size !== value.checks.length ||
    value.policy.requiredChecks.some((kind) => !value.checks.some((check) => check.kind === kind)) ||
    new Set(value.traceToAcceptance.map((item) => item.criterionId)).size !== value.traceToAcceptance.length ||
    [...value.checks, ...value.traceToAcceptance].some((item) => item.status !== "PASSED" || item.evidenceIds.length === 0)
  )) {
    context.addIssue({ code: "custom", message: "Ready assessments require complete passing coverage" });
  }
});
export type ReleaseAssessment = z.infer<typeof ReleaseAssessmentSchema>;

/** Invalid input is never an assessment, and never echoes arbitrary input or logs. */
export class QualityInputError extends Error {
  override readonly name = "QualityInputError";
  readonly code = "QUALITY_INPUT_INVALID";
  constructor() { super("QUALITY_INPUT_INVALID"); }
}

export function parseQualityInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new QualityInputError();
  return result.data;
}

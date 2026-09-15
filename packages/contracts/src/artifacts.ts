import { z } from "zod";

const ShortTextSchema = z.string().trim().min(1).max(500);
const LongTextSchema = z.string().trim().min(1).max(20_000);

export const SeoPackageVersionSchema = z.literal("v1");
export type SeoPackageVersion = z.infer<typeof SeoPackageVersionSchema>;

export const SeoFindingSeveritySchema = z.enum(["INFO", "WARNING", "BLOCKING"]);
export type SeoFindingSeverity = z.infer<typeof SeoFindingSeveritySchema>;

export const SeoRouteMetadataSchema = z
  .object({
    routePath: z.string().trim().min(1).max(1_024),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(320),
    canonicalUrl: z.string().url().max(2_048).nullable(),
  })
  .strict();
export type SeoRouteMetadata = z.infer<typeof SeoRouteMetadataSchema>;

export const SeoFindingSchema = z
  .object({
    severity: SeoFindingSeveritySchema,
    subject: ShortTextSchema,
    recommendation: ShortTextSchema,
  })
  .strict();
export type SeoFinding = z.infer<typeof SeoFindingSchema>;

export const SeoPackageSchema = z
  .object({
    version: SeoPackageVersionSchema,
    sitemapXml: z.string().trim().min(1).max(2_000_000),
    robotsTxt: z.string().trim().min(1).max(20_000),
    routeMetadata: z.array(SeoRouteMetadataSchema).min(1).max(500),
    findings: z.array(SeoFindingSchema).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    const seenRoutes = new Set<string>();
    value.routeMetadata.forEach((item, index) => {
      if (seenRoutes.has(item.routePath)) {
        context.addIssue({
          code: "custom",
          path: ["routeMetadata", index, "routePath"],
          message: "route paths must be unique",
        });
      }
      seenRoutes.add(item.routePath);
    });
  });
export type SeoPackage = z.infer<typeof SeoPackageSchema>;

export const ContentPackageVersionSchema = z.literal("v1");
export type ContentPackageVersion = z.infer<typeof ContentPackageVersionSchema>;

export const ContentAdChannelSchema = z.enum([
  "SEARCH",
  "SOCIAL",
  "DISPLAY",
  "EMAIL",
]);
export type ContentAdChannel = z.infer<typeof ContentAdChannelSchema>;

export const ContentCtaVariantSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    headline: z.string().trim().min(1).max(160),
    body: LongTextSchema,
    ctaLabel: z.string().trim().min(1).max(80),
  })
  .strict();
export type ContentCtaVariant = z.infer<typeof ContentCtaVariantSchema>;

export const ContentAdVariantSchema = z
  .object({
    channel: ContentAdChannelSchema,
    headline: z.string().trim().min(1).max(120),
    body: LongTextSchema,
    ctaLabel: z.string().trim().min(1).max(80).nullable(),
  })
  .strict();
export type ContentAdVariant = z.infer<typeof ContentAdVariantSchema>;

export const EvidenceRequirementStatusSchema = z.enum(["REQUIRED", "PROVIDED"]);
export type EvidenceRequirementStatus = z.infer<
  typeof EvidenceRequirementStatusSchema
>;

export const ClaimEvidenceRequirementSchema = z
  .object({
    claim: LongTextSchema,
    evidenceStatus: EvidenceRequirementStatusSchema,
    notes: ShortTextSchema.nullable(),
  })
  .strict();
export type ClaimEvidenceRequirement = z.infer<
  typeof ClaimEvidenceRequirementSchema
>;

export const ContentPackageSchema = z
  .object({
    version: ContentPackageVersionSchema,
    audience: ShortTextSchema,
    valuePropositions: z.array(ShortTextSchema).min(1).max(20),
    ctaVariants: z.array(ContentCtaVariantSchema).min(1).max(100),
    adVariants: z.array(ContentAdVariantSchema).max(100),
    claimsRequiringEvidence: z
      .array(ClaimEvidenceRequirementSchema)
      .max(200),
  })
  .strict()
  .superRefine((value, context) => {
    const seenIds = new Set<string>();
    value.ctaVariants.forEach((variant, index) => {
      if (seenIds.has(variant.id)) {
        context.addIssue({
          code: "custom",
          path: ["ctaVariants", index, "id"],
          message: "cta variant ids must be unique",
        });
      }
      seenIds.add(variant.id);
    });
  });
export type ContentPackage = z.infer<typeof ContentPackageSchema>;

export const CustomerSuccessPackageVersionSchema = z.literal("v1");
export type CustomerSuccessPackageVersion = z.infer<
  typeof CustomerSuccessPackageVersionSchema
>;

export const OnboardingMilestoneStatusSchema = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "COMPLETED",
  "BLOCKED",
]);
export type OnboardingMilestoneStatus = z.infer<
  typeof OnboardingMilestoneStatusSchema
>;

export const OnboardingMilestoneSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    name: ShortTextSchema,
    description: LongTextSchema,
    owner: z.enum(["CUSTOMER", "CUSTOMER_SUCCESS", "SHARED"]),
    status: OnboardingMilestoneStatusSchema,
    targetDate: z.string().date().nullable(),
  })
  .strict();
export type OnboardingMilestone = z.infer<typeof OnboardingMilestoneSchema>;

export const ActivationEvidenceStatusSchema = z.enum([
  "EVIDENCED",
  "ASSUMPTION",
  "RESEARCH_REQUIRED",
]);
export type ActivationEvidenceStatus = z.infer<
  typeof ActivationEvidenceStatusSchema
>;

export const ActivationMilestoneSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    milestoneName: ShortTextSchema,
    definitionOfFirstValue: LongTextSchema,
    achieved: z.boolean(),
    achievedAt: z.string().datetime({ offset: true }).nullable(),
    evidenceStatus: ActivationEvidenceStatusSchema,
  })
  .strict();
export type ActivationMilestone = z.infer<typeof ActivationMilestoneSchema>;

export const HealthSignalSeveritySchema = z.enum([
  "HEALTHY",
  "AT_RISK",
  "CRITICAL",
]);
export type HealthSignalSeverity = z.infer<typeof HealthSignalSeveritySchema>;

export const HealthSignalSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    signal: ShortTextSchema,
    severity: HealthSignalSeveritySchema,
    observedEvidence: LongTextSchema,
    recommendation: ShortTextSchema,
  })
  .strict();
export type HealthSignal = z.infer<typeof HealthSignalSchema>;

export const ChurnRiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type ChurnRiskLevel = z.infer<typeof ChurnRiskLevelSchema>;

export const ChurnRiskAssessmentSchema = z
  .object({
    riskLevel: ChurnRiskLevelSchema,
    primaryDrivers: z.array(ShortTextSchema).max(20),
    mitigationPlan: z.array(ShortTextSchema).max(20),
  })
  .strict();
export type ChurnRiskAssessment = z.infer<typeof ChurnRiskAssessmentSchema>;

export const RetentionProposalTypeSchema = z.enum([
  "RENEWAL",
  "EXPANSION",
  "WIN_BACK",
]);
export type RetentionProposalType = z.infer<
  typeof RetentionProposalTypeSchema
>;

export const RetentionApprovalReasonSchema = z.enum([
  "DISCOUNT",
  "CONTRACT_CHANGE",
  "BILLING_CHANGE",
  "EXTERNAL_COMMUNICATION",
  "ACCOUNT_CHANGE",
]);
export type RetentionApprovalReason = z.infer<
  typeof RetentionApprovalReasonSchema
>;

export const RetentionProposalSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    type: RetentionProposalTypeSchema,
    rationale: LongTextSchema,
    proposedAction: ShortTextSchema,
    // Structurally forbids an unapproved proposal: the agent can never emit
    // a retention action that claims to skip human approval.
    requiresApproval: z.literal(true),
    approvalReason: RetentionApprovalReasonSchema,
  })
  .strict();
export type RetentionProposal = z.infer<typeof RetentionProposalSchema>;

export const CustomerSuccessPackageSchema = z
  .object({
    version: CustomerSuccessPackageVersionSchema,
    onboardingMilestones: z.array(OnboardingMilestoneSchema).min(1).max(100),
    activationMilestones: z.array(ActivationMilestoneSchema).min(1).max(50),
    healthSignals: z.array(HealthSignalSchema).max(100),
    churnRisk: ChurnRiskAssessmentSchema,
    retentionProposals: z.array(RetentionProposalSchema).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    const seenMilestoneIds = new Set<string>();
    value.onboardingMilestones.forEach((item, index) => {
      if (seenMilestoneIds.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["onboardingMilestones", index, "id"],
          message: "onboarding milestone ids must be unique",
        });
      }
      seenMilestoneIds.add(item.id);
    });
    const seenSignalIds = new Set<string>();
    value.healthSignals.forEach((item, index) => {
      if (seenSignalIds.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["healthSignals", index, "id"],
          message: "health signal ids must be unique",
        });
      }
      seenSignalIds.add(item.id);
    });
  });
export type CustomerSuccessPackage = z.infer<
  typeof CustomerSuccessPackageSchema
>;

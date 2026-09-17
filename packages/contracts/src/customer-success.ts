import { z } from "zod";

import {
  ChurnRiskLevelSchema,
  HealthSignalSeveritySchema,
  OnboardingMilestoneStatusSchema,
  RetentionApprovalReasonSchema,
  RetentionProposalTypeSchema,
} from "./artifacts.js";
import { EvidenceStatusSchema } from "./gtm.js";
import { JsonValueSchema } from "./json.js";

const IsoTimestampSchema = z.string().datetime({ offset: true });

/**
 * Response shapes for the Customer Success persistence layer (data model
 * only -- no route exposes these yet, and CustomerSuccess is not wired
 * into apps/orchestrator-worker/src/graph.ts). Each shape mirrors the
 * corresponding array item in artifacts.ts's CustomerSuccessPackageSchema
 * (the agent's ephemeral output contract) plus persistence fields
 * (id, customerAccountId, timestamps) -- reusing that file's enums
 * (ChurnRiskLevel, HealthSignalSeverity, OnboardingMilestoneStatus,
 * RetentionApprovalReason, RetentionProposalType) rather than redeclaring
 * them, since the value sets must stay identical.
 */

export const CustomerAccountStatusSchema = z.enum([
  "ONBOARDING",
  "ACTIVATING",
  "ACTIVE",
  "AT_RISK",
  "RENEWAL_DUE",
  "RENEWED",
  "CHURNED",
  "EXPANDED",
]);
export type CustomerAccountStatus = z.infer<typeof CustomerAccountStatusSchema>;

export const CustomerAccountResponseSchema = z
  .object({
    id: z.string().uuid(),
    gtmScopeId: z.string().uuid(),
    dealId: z.string().uuid(),
    prospectId: z.string().uuid(),
    handoffId: z.string().uuid(),
    status: CustomerAccountStatusSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type CustomerAccountResponse = z.infer<
  typeof CustomerAccountResponseSchema
>;

export const CustomerAccountListResponseSchema = z
  .object({
    items: z.array(CustomerAccountResponseSchema).max(10_000),
  })
  .strict();
export type CustomerAccountListResponse = z.infer<
  typeof CustomerAccountListResponseSchema
>;

export const MilestoneOwnerSchema = z.enum([
  "CUSTOMER",
  "CUSTOMER_SUCCESS",
  "SHARED",
]);
export type MilestoneOwner = z.infer<typeof MilestoneOwnerSchema>;

export const OnboardingMilestoneResponseSchema = z
  .object({
    id: z.string().uuid(),
    customerAccountId: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    owner: MilestoneOwnerSchema,
    status: OnboardingMilestoneStatusSchema,
    targetDate: z.string().date().nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type OnboardingMilestoneResponse = z.infer<
  typeof OnboardingMilestoneResponseSchema
>;

export const OnboardingMilestoneListResponseSchema = z
  .object({
    items: z.array(OnboardingMilestoneResponseSchema).max(1_000),
  })
  .strict();
export type OnboardingMilestoneListResponse = z.infer<
  typeof OnboardingMilestoneListResponseSchema
>;

export const ActivationMilestoneResponseSchema = z
  .object({
    id: z.string().uuid(),
    customerAccountId: z.string().uuid(),
    milestoneName: z.string(),
    definitionOfFirstValue: z.string(),
    achieved: z.boolean(),
    achievedAt: IsoTimestampSchema.nullable(),
    evidenceStatus: EvidenceStatusSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type ActivationMilestoneResponse = z.infer<
  typeof ActivationMilestoneResponseSchema
>;

export const ActivationMilestoneListResponseSchema = z
  .object({
    items: z.array(ActivationMilestoneResponseSchema).max(1_000),
  })
  .strict();
export type ActivationMilestoneListResponse = z.infer<
  typeof ActivationMilestoneListResponseSchema
>;

export const HealthSignalResponseSchema = z
  .object({
    id: z.string().uuid(),
    customerAccountId: z.string().uuid(),
    signal: z.string(),
    severity: HealthSignalSeveritySchema,
    observedEvidence: z.string(),
    recommendation: z.string(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type HealthSignalResponse = z.infer<typeof HealthSignalResponseSchema>;

export const HealthSignalListResponseSchema = z
  .object({
    items: z.array(HealthSignalResponseSchema).max(10_000),
  })
  .strict();
export type HealthSignalListResponse = z.infer<
  typeof HealthSignalListResponseSchema
>;

export const ChurnRiskAssessmentResponseSchema = z
  .object({
    id: z.string().uuid(),
    customerAccountId: z.string().uuid(),
    riskLevel: ChurnRiskLevelSchema,
    primaryDrivers: JsonValueSchema,
    mitigationPlan: JsonValueSchema,
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type ChurnRiskAssessmentResponse = z.infer<
  typeof ChurnRiskAssessmentResponseSchema
>;

export const ChurnRiskAssessmentListResponseSchema = z
  .object({
    items: z.array(ChurnRiskAssessmentResponseSchema).max(10_000),
  })
  .strict();
export type ChurnRiskAssessmentListResponse = z.infer<
  typeof ChurnRiskAssessmentListResponseSchema
>;

// Not part of the ephemeral agent output (which only ever asserts
// requiresApproval: true) -- a persisted proposal needs a disposition to
// track once a human acts on it.
export const RetentionProposalStatusSchema = z.enum([
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
]);
export type RetentionProposalStatus = z.infer<
  typeof RetentionProposalStatusSchema
>;

export const RetentionProposalResponseSchema = z
  .object({
    id: z.string().uuid(),
    customerAccountId: z.string().uuid(),
    type: RetentionProposalTypeSchema,
    rationale: z.string(),
    proposedAction: z.string(),
    approvalReason: RetentionApprovalReasonSchema,
    status: RetentionProposalStatusSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type RetentionProposalResponse = z.infer<
  typeof RetentionProposalResponseSchema
>;

export const RetentionProposalListResponseSchema = z
  .object({
    items: z.array(RetentionProposalResponseSchema).max(10_000),
  })
  .strict();
export type RetentionProposalListResponse = z.infer<
  typeof RetentionProposalListResponseSchema
>;

import { z } from "zod";

import { JsonValueSchema } from "./json.js";

const IsoTimestampSchema = z.string().datetime({ offset: true });

/**
 * PLATFORM_GTM sells Atoms itself and may resolve only through a workspace.
 * PROJECT_GTM sells one customer-generated product and must also resolve
 * through that project. The two scopes never share data, credentials,
 * leads, campaigns, or suppression lists.
 */
export const GtmModeSchema = z.enum(["PLATFORM_GTM", "PROJECT_GTM"]);
export type GtmMode = z.infer<typeof GtmModeSchema>;

export const GtmScopeResponseSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    projectId: z.string().uuid().nullable(),
    mode: GtmModeSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type GtmScopeResponse = z.infer<typeof GtmScopeResponseSchema>;

export const GtmScopeListResponseSchema = z
  .object({
    items: z.array(GtmScopeResponseSchema).max(1_000),
  })
  .strict();
export type GtmScopeListResponse = z.infer<typeof GtmScopeListResponseSchema>;

export const CreateGtmScopeInputSchema = z
  .object({
    mode: GtmModeSchema,
    projectId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "PROJECT_GTM" && value.projectId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "PROJECT_GTM requires projectId",
      });
    }
    if (value.mode === "PLATFORM_GTM" && value.projectId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "PLATFORM_GTM must not set projectId",
      });
    }
  });
export type CreateGtmScopeInput = z.infer<typeof CreateGtmScopeInputSchema>;

export const EvidenceStatusSchema = z.enum([
  "EVIDENCED",
  "ASSUMPTION",
  "RESEARCH_REQUIRED",
]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const ProspectSourceSchema = z.enum(["APOLLO", "MANUAL"]);
export type ProspectSource = z.infer<typeof ProspectSourceSchema>;

export const ProspectStatusSchema = z.enum([
  "DISCOVERED",
  "ENRICHED",
  "QUALIFIED",
  "OUTREACH_READY",
  "IN_SEQUENCE",
  "CUSTOMER",
  "DISQUALIFIED",
  "SUPPRESSED",
]);
export type ProspectStatus = z.infer<typeof ProspectStatusSchema>;

export const LeadScoreBandSchema = z.enum(["COLD", "WARM", "HOT"]);
export type LeadScoreBand = z.infer<typeof LeadScoreBandSchema>;

export const ProspectResponseSchema = z
  .object({
    id: z.string().uuid(),
    gtmScopeId: z.string().uuid(),
    companyName: z.string(),
    companyDomain: z.string().nullable(),
    contactName: z.string(),
    contactEmail: z.string(),
    normalizedEmail: z.string(),
    contactTitle: z.string().nullable(),
    industry: z.string().nullable(),
    companySizeHeadcount: z.number().int().nonnegative().nullable(),
    useCase: z.string(),
    fitEvidenceStatus: EvidenceStatusSchema,
    fitEvidenceNotes: z.string().nullable(),
    source: ProspectSourceSchema,
    sourceExternalId: z.string().nullable(),
    status: ProspectStatusSchema,
    currentScore: z.number().int().nullable(),
    currentScoreBand: LeadScoreBandSchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type ProspectResponse = z.infer<typeof ProspectResponseSchema>;

export const ProspectListResponseSchema = z
  .object({
    items: z.array(ProspectResponseSchema).max(10_000),
  })
  .strict();
export type ProspectListResponse = z.infer<typeof ProspectListResponseSchema>;

export const CreateProspectInputSchema = z
  .object({
    companyName: z.string().trim().min(1).max(160),
    companyDomain: z.string().trim().min(1).max(255).optional(),
    contactName: z.string().trim().min(1).max(160),
    contactEmail: z.string().trim().email().max(320),
    contactTitle: z.string().trim().min(1).max(160).optional(),
    industry: z.string().trim().min(1).max(160).optional(),
    companySizeHeadcount: z.number().int().nonnegative().optional(),
    useCase: z.string().trim().min(1),
    fitEvidenceStatus: EvidenceStatusSchema,
    fitEvidenceNotes: z.string().trim().min(1).optional(),
    source: ProspectSourceSchema,
    sourceExternalId: z.string().trim().min(1).max(191).optional(),
  })
  .strict();
export type CreateProspectInput = z.infer<typeof CreateProspectInputSchema>;

export const LeadScoreResponseSchema = z
  .object({
    id: z.string().uuid(),
    prospectId: z.string().uuid(),
    score: z.number().int(),
    band: LeadScoreBandSchema,
    scoringVersion: z.string(),
    rationale: JsonValueSchema,
    computedAt: IsoTimestampSchema,
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type LeadScoreResponse = z.infer<typeof LeadScoreResponseSchema>;

export const LeadScoreListResponseSchema = z
  .object({
    items: z.array(LeadScoreResponseSchema).max(10_000),
  })
  .strict();
export type LeadScoreListResponse = z.infer<typeof LeadScoreListResponseSchema>;

// No live scoring worker exists yet (see packages/revenue), so a score is
// recorded exactly as supplied -- there is no server-side computation to
// trust or distrust here, only a record of one.
export const CreateLeadScoreInputSchema = z
  .object({
    score: z.number().int(),
    band: LeadScoreBandSchema,
    scoringVersion: z.string().trim().min(1).max(20),
    rationale: JsonValueSchema,
    computedAt: IsoTimestampSchema,
  })
  .strict();
export type CreateLeadScoreInput = z.infer<typeof CreateLeadScoreInputSchema>;

export const OutreachSequenceStatusSchema = z.enum([
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
]);
export type OutreachSequenceStatus = z.infer<
  typeof OutreachSequenceStatusSchema
>;

export const OutreachChannelSchema = z.enum(["EMAIL", "LINKEDIN", "CALL"]);
export type OutreachChannel = z.infer<typeof OutreachChannelSchema>;

export const OutreachEventKindSchema = z.enum([
  "QUEUED",
  "SENT",
  "OPENED",
  "CLICKED",
  "REPLIED",
  "BOUNCED",
  "FAILED",
  "SUPPRESSED",
]);
export type OutreachEventKind = z.infer<typeof OutreachEventKindSchema>;

export const OutreachSequenceResponseSchema = z
  .object({
    id: z.string().uuid(),
    gtmScopeId: z.string().uuid(),
    name: z.string(),
    status: OutreachSequenceStatusSchema,
    steps: JsonValueSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type OutreachSequenceResponse = z.infer<
  typeof OutreachSequenceResponseSchema
>;

export const OutreachSequenceListResponseSchema = z
  .object({
    items: z.array(OutreachSequenceResponseSchema).max(1_000),
  })
  .strict();
export type OutreachSequenceListResponse = z.infer<
  typeof OutreachSequenceListResponseSchema
>;

const OutreachSequenceStepSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    channel: OutreachChannelSchema,
    templateRef: z.string().trim().min(1),
    waitDays: z.number().int().nonnegative(),
  })
  .strict();

export const CreateOutreachSequenceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    status: OutreachSequenceStatusSchema.optional(),
    steps: z.array(OutreachSequenceStepSchema).max(50),
  })
  .strict();
export type CreateOutreachSequenceInput = z.infer<
  typeof CreateOutreachSequenceInputSchema
>;

export const OutreachEventResponseSchema = z
  .object({
    id: z.string().uuid(),
    sequenceId: z.string().uuid(),
    prospectId: z.string().uuid(),
    stepOrdinal: z.number().int().nonnegative(),
    channel: OutreachChannelSchema,
    kind: OutreachEventKindSchema,
    providerMessageId: z.string().nullable(),
    occurredAt: IsoTimestampSchema,
    metadata: JsonValueSchema.nullable(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type OutreachEventResponse = z.infer<typeof OutreachEventResponseSchema>;

export const OutreachEventListResponseSchema = z
  .object({
    items: z.array(OutreachEventResponseSchema).max(10_000),
  })
  .strict();
export type OutreachEventListResponse = z.infer<
  typeof OutreachEventListResponseSchema
>;

// The schema's own unique constraint is (sequenceId, prospectId, stepOrdinal)
// -- one row per step per prospect, not one row per lifecycle transition --
// so recording an event is an upsert keyed on that triple: it advances the
// step's latest known outcome (SENT, then later OPENED, then CLICKED, ...)
// rather than appending a new row per transition.
export const RecordOutreachEventInputSchema = z
  .object({
    prospectId: z.string().uuid(),
    stepOrdinal: z.number().int().nonnegative(),
    channel: OutreachChannelSchema,
    kind: OutreachEventKindSchema,
    providerMessageId: z.string().trim().min(1).max(191).optional(),
    occurredAt: IsoTimestampSchema,
    metadata: JsonValueSchema.optional(),
  })
  .strict();
export type RecordOutreachEventInput = z.infer<
  typeof RecordOutreachEventInputSchema
>;

export const SuppressionChannelSchema = z.enum(["EMAIL", "LINKEDIN", "ALL"]);
export type SuppressionChannel = z.infer<typeof SuppressionChannelSchema>;

export const SuppressionReasonSchema = z.enum([
  "UNSUBSCRIBED",
  "BOUNCED",
  "COMPLAINT",
  "MANUAL",
  "LEGAL_HOLD",
]);
export type SuppressionReason = z.infer<typeof SuppressionReasonSchema>;

export const SuppressionEntryResponseSchema = z
  .object({
    id: z.string().uuid(),
    gtmScopeId: z.string().uuid(),
    channel: SuppressionChannelSchema,
    normalizedIdentifier: z.string(),
    reason: SuppressionReasonSchema,
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type SuppressionEntryResponse = z.infer<
  typeof SuppressionEntryResponseSchema
>;

export const SuppressionEntryListResponseSchema = z
  .object({
    items: z.array(SuppressionEntryResponseSchema).max(10_000),
  })
  .strict();
export type SuppressionEntryListResponse = z.infer<
  typeof SuppressionEntryListResponseSchema
>;

export const CreateSuppressionEntryInputSchema = z
  .object({
    channel: SuppressionChannelSchema,
    identifier: z.string().trim().min(1).max(320),
    reason: SuppressionReasonSchema,
  })
  .strict();
export type CreateSuppressionEntryInput = z.infer<
  typeof CreateSuppressionEntryInputSchema
>;

// Deliberately its own enum, not IntegrationProvider (which tracks
// project-level provider connections and is unrelated to CRM sync targets)
// -- Apollo is a prospecting/enrichment provider, never a CRM sync target.
export const CrmProviderSchema = z.enum(["HUBSPOT"]);
export type CrmProvider = z.infer<typeof CrmProviderSchema>;

export const CrmEntityTypeSchema = z.enum(["CONTACT", "COMPANY", "DEAL"]);
export type CrmEntityType = z.infer<typeof CrmEntityTypeSchema>;

export const CrmSyncStatusSchema = z.enum([
  "PENDING",
  "SYNCED",
  "FAILED",
  "CONFLICT",
]);
export type CrmSyncStatus = z.infer<typeof CrmSyncStatusSchema>;

export const CrmSyncRecordResponseSchema = z
  .object({
    id: z.string().uuid(),
    gtmScopeId: z.string().uuid(),
    provider: CrmProviderSchema,
    entityType: CrmEntityTypeSchema,
    prospectId: z.string().uuid().nullable(),
    dealId: z.string().uuid().nullable(),
    externalId: z.string().nullable(),
    status: CrmSyncStatusSchema,
    lastSyncedAt: IsoTimestampSchema.nullable(),
    lastAttemptAt: IsoTimestampSchema.nullable(),
    error: JsonValueSchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const targetsDeal = value.entityType === "DEAL";
    if (targetsDeal && (value.dealId === null || value.prospectId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["dealId"],
        message: "a DEAL sync record must set dealId and leave prospectId null",
      });
    }
    if (!targetsDeal && (value.prospectId === null || value.dealId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["prospectId"],
        message:
          "a CONTACT or COMPANY sync record must set prospectId and leave dealId null",
      });
    }
  });
export type CrmSyncRecordResponse = z.infer<typeof CrmSyncRecordResponseSchema>;

export const CrmSyncRecordListResponseSchema = z
  .object({
    items: z.array(CrmSyncRecordResponseSchema).max(10_000),
  })
  .strict();
export type CrmSyncRecordListResponse = z.infer<
  typeof CrmSyncRecordListResponseSchema
>;

export const DealStageSchema = z.enum([
  "PROSPECTING",
  "QUALIFICATION",
  "PROPOSAL",
  "NEGOTIATION",
  "CLOSED_WON",
  "CLOSED_LOST",
]);
export type DealStage = z.infer<typeof DealStageSchema>;

export const DealResponseSchema = z
  .object({
    id: z.string().uuid(),
    gtmScopeId: z.string().uuid(),
    prospectId: z.string().uuid(),
    name: z.string(),
    stage: DealStageSchema,
    amountUsdMicros: z.string().regex(/^\d+$/).nullable(), // BigInt serialized as decimal string
    closeDateExpected: z.string().date().nullable(),
    closedAt: IsoTimestampSchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type DealResponse = z.infer<typeof DealResponseSchema>;

export const DealListResponseSchema = z
  .object({
    items: z.array(DealResponseSchema).max(10_000),
  })
  .strict();
export type DealListResponse = z.infer<typeof DealListResponseSchema>;

export const CreateDealInputSchema = z
  .object({
    prospectId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    stage: DealStageSchema.optional(),
    amountUsdMicros: z
      .string()
      .regex(/^\d+$/)
      .optional(),
    closeDateExpected: z.string().date().optional(),
  })
  .strict();
export type CreateDealInput = z.infer<typeof CreateDealInputSchema>;

export const UpdateDealStageInputSchema = z
  .object({
    stage: DealStageSchema,
  })
  .strict();
export type UpdateDealStageInput = z.infer<typeof UpdateDealStageInputSchema>;

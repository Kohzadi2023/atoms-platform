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

export const CrmProviderSchema = z.enum(["SUPABASE", "APOLLO", "HUBSPOT"]);
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

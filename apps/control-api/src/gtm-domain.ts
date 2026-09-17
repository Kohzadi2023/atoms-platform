import {
  CrmEntityTypeSchema,
  CrmProviderSchema,
  CrmSyncStatusSchema,
  DealStageSchema,
  EvidenceStatusSchema,
  GtmModeSchema,
  JsonValueSchema,
  LeadScoreBandSchema,
  OutreachChannelSchema,
  OutreachEventKindSchema,
  OutreachSequenceStatusSchema,
  ProspectSourceSchema,
  ProspectStatusSchema,
  SuppressionChannelSchema,
  SuppressionReasonSchema,
  type CrmEntityType,
  type CrmProvider,
  type CrmSyncRecordResponse,
  type CrmSyncStatus,
  type DealResponse,
  type EvidenceStatus,
  type GtmMode,
  type GtmScopeResponse,
  type JsonValue,
  type LeadScoreBand,
  type LeadScoreResponse,
  type OutreachChannel,
  type OutreachEventKind,
  type OutreachEventResponse,
  type OutreachSequenceResponse,
  type OutreachSequenceStatus,
  type ProspectResponse,
  type ProspectSource,
  type ProspectStatus,
  type SuppressionChannel,
  type SuppressionEntryResponse,
  type SuppressionReason,
  type DealStage,
} from "@atoms/contracts";

export interface GtmScopeRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly mode: GtmMode;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProspectRecord {
  readonly id: string;
  readonly gtmScopeId: string;
  readonly companyName: string;
  readonly companyDomain: string | null;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly normalizedEmail: string;
  readonly contactTitle: string | null;
  readonly industry: string | null;
  readonly companySizeHeadcount: number | null;
  readonly useCase: string;
  readonly fitEvidenceStatus: EvidenceStatus;
  readonly fitEvidenceNotes: string | null;
  readonly source: ProspectSource;
  readonly sourceExternalId: string | null;
  readonly status: ProspectStatus;
  readonly currentScore: number | null;
  readonly currentScoreBand: LeadScoreBand | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DealRecord {
  readonly id: string;
  readonly gtmScopeId: string;
  readonly prospectId: string;
  readonly name: string;
  readonly stage: DealStage;
  readonly amountUsdMicros: bigint | null;
  readonly closeDateExpected: Date | null;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toGtmScopeResponse(record: GtmScopeRecord): GtmScopeResponse {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    mode: GtmModeSchema.parse(record.mode),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toProspectResponse(record: ProspectRecord): ProspectResponse {
  return {
    id: record.id,
    gtmScopeId: record.gtmScopeId,
    companyName: record.companyName,
    companyDomain: record.companyDomain,
    contactName: record.contactName,
    contactEmail: record.contactEmail,
    normalizedEmail: record.normalizedEmail,
    contactTitle: record.contactTitle,
    industry: record.industry,
    companySizeHeadcount: record.companySizeHeadcount,
    useCase: record.useCase,
    fitEvidenceStatus: EvidenceStatusSchema.parse(record.fitEvidenceStatus),
    fitEvidenceNotes: record.fitEvidenceNotes,
    source: ProspectSourceSchema.parse(record.source),
    sourceExternalId: record.sourceExternalId,
    status: ProspectStatusSchema.parse(record.status),
    currentScore: record.currentScore,
    currentScoreBand:
      record.currentScoreBand === null
        ? null
        : LeadScoreBandSchema.parse(record.currentScoreBand),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toDealResponse(record: DealRecord): DealResponse {
  return {
    id: record.id,
    gtmScopeId: record.gtmScopeId,
    prospectId: record.prospectId,
    name: record.name,
    stage: DealStageSchema.parse(record.stage),
    amountUsdMicros:
      record.amountUsdMicros === null ? null : record.amountUsdMicros.toString(),
    closeDateExpected:
      record.closeDateExpected === null
        ? null
        : (record.closeDateExpected.toISOString().split("T")[0] ?? null),
    closedAt: record.closedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export interface LeadScoreRecord {
  readonly id: string;
  readonly prospectId: string;
  readonly score: number;
  readonly band: LeadScoreBand;
  readonly scoringVersion: string;
  readonly rationale: JsonValue;
  readonly computedAt: Date;
  readonly createdAt: Date;
}

export function toLeadScoreResponse(record: LeadScoreRecord): LeadScoreResponse {
  return {
    id: record.id,
    prospectId: record.prospectId,
    score: record.score,
    band: LeadScoreBandSchema.parse(record.band),
    scoringVersion: record.scoringVersion,
    rationale: JsonValueSchema.parse(record.rationale),
    computedAt: record.computedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

export interface OutreachSequenceRecord {
  readonly id: string;
  readonly gtmScopeId: string;
  readonly name: string;
  readonly status: OutreachSequenceStatus;
  readonly steps: JsonValue;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toOutreachSequenceResponse(
  record: OutreachSequenceRecord,
): OutreachSequenceResponse {
  return {
    id: record.id,
    gtmScopeId: record.gtmScopeId,
    name: record.name,
    status: OutreachSequenceStatusSchema.parse(record.status),
    steps: JsonValueSchema.parse(record.steps),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export interface OutreachEventRecord {
  readonly id: string;
  readonly sequenceId: string;
  readonly prospectId: string;
  readonly stepOrdinal: number;
  readonly channel: OutreachChannel;
  readonly kind: OutreachEventKind;
  readonly providerMessageId: string | null;
  readonly occurredAt: Date;
  readonly metadata: JsonValue | null;
  readonly createdAt: Date;
}

export function toOutreachEventResponse(
  record: OutreachEventRecord,
): OutreachEventResponse {
  return {
    id: record.id,
    sequenceId: record.sequenceId,
    prospectId: record.prospectId,
    stepOrdinal: record.stepOrdinal,
    channel: OutreachChannelSchema.parse(record.channel),
    kind: OutreachEventKindSchema.parse(record.kind),
    providerMessageId: record.providerMessageId,
    occurredAt: record.occurredAt.toISOString(),
    metadata: record.metadata === null ? null : JsonValueSchema.parse(record.metadata),
    createdAt: record.createdAt.toISOString(),
  };
}

export interface SuppressionEntryRecord {
  readonly id: string;
  readonly gtmScopeId: string;
  readonly channel: SuppressionChannel;
  readonly normalizedIdentifier: string;
  readonly reason: SuppressionReason;
  readonly createdAt: Date;
}

export function toSuppressionEntryResponse(
  record: SuppressionEntryRecord,
): SuppressionEntryResponse {
  return {
    id: record.id,
    gtmScopeId: record.gtmScopeId,
    channel: SuppressionChannelSchema.parse(record.channel),
    normalizedIdentifier: record.normalizedIdentifier,
    reason: SuppressionReasonSchema.parse(record.reason),
    createdAt: record.createdAt.toISOString(),
  };
}

export interface CrmSyncRecordRecord {
  readonly id: string;
  readonly gtmScopeId: string;
  readonly provider: CrmProvider;
  readonly entityType: CrmEntityType;
  readonly prospectId: string | null;
  readonly dealId: string | null;
  readonly externalId: string | null;
  readonly status: CrmSyncStatus;
  readonly lastSyncedAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly error: JsonValue | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toCrmSyncRecordResponse(
  record: CrmSyncRecordRecord,
): CrmSyncRecordResponse {
  return {
    id: record.id,
    gtmScopeId: record.gtmScopeId,
    provider: CrmProviderSchema.parse(record.provider),
    entityType: CrmEntityTypeSchema.parse(record.entityType),
    prospectId: record.prospectId,
    dealId: record.dealId,
    externalId: record.externalId,
    status: CrmSyncStatusSchema.parse(record.status),
    lastSyncedAt: record.lastSyncedAt?.toISOString() ?? null,
    lastAttemptAt: record.lastAttemptAt?.toISOString() ?? null,
    error: record.error === null ? null : JsonValueSchema.parse(record.error),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

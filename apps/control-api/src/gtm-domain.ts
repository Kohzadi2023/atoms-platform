import {
  DealStageSchema,
  EvidenceStatusSchema,
  GtmModeSchema,
  LeadScoreBandSchema,
  ProspectSourceSchema,
  ProspectStatusSchema,
  type DealResponse,
  type EvidenceStatus,
  type GtmMode,
  type GtmScopeResponse,
  type LeadScoreBand,
  type ProspectResponse,
  type ProspectSource,
  type ProspectStatus,
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

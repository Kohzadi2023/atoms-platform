/**
 * Provider-neutral adapter interfaces for Sophia's Revenue & GTM layer.
 * These are type definitions only -- see README.md for what is and is not
 * implemented yet.
 */

export interface ProspectDiscoveryQuery {
  readonly operationId: string;
  readonly industry?: string;
  readonly companySizeMin?: number;
  readonly companySizeMax?: number;
  readonly titles?: readonly string[];
  readonly limit: number;
}

export interface DiscoveredProspect {
  readonly externalId: string;
  readonly companyName: string;
  readonly companyDomain: string | null;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactTitle: string | null;
  readonly industry: string | null;
  readonly companySizeHeadcount: number | null;
}

export interface ProspectEnrichmentResult {
  readonly externalId: string;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ProspectingProvider {
  readonly name: "APOLLO";
  discover(query: ProspectDiscoveryQuery): Promise<readonly DiscoveredProspect[]>;
  enrich(externalId: string): Promise<ProspectEnrichmentResult>;
}

export type CrmObjectType = "CONTACT" | "COMPANY" | "DEAL";

export interface CrmSyncInput {
  readonly operationId: string;
  readonly objectType: CrmObjectType;
  readonly localId: string;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
  readonly externalId?: string;
}

export interface CrmSyncResult {
  readonly operationId: string;
  readonly provider: "HUBSPOT";
  readonly objectType: CrmObjectType;
  readonly externalId: string;
  readonly status: "SYNCED" | "CONFLICT";
}

export interface CrmPipelineStage {
  readonly externalId: string;
  readonly label: string;
  readonly ordinal: number;
}

export interface CrmProvider {
  readonly name: "HUBSPOT";
  syncObject(input: CrmSyncInput): Promise<CrmSyncResult>;
  listPipelineStages(pipelineExternalId: string): Promise<readonly CrmPipelineStage[]>;
}

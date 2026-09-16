import assert from "node:assert/strict";
import test from "node:test";

import { RevenueProviderError } from "./errors.js";
import type {
  CrmPipelineStage,
  CrmProvider,
  CrmSyncInput,
  CrmSyncResult,
  DiscoveredProspect,
  ProspectDiscoveryQuery,
  ProspectEnrichmentResult,
  ProspectingProvider,
} from "./types.js";

// No reusable mock is exported from this package, matching
// @atoms/database-provider's convention: every consumer defines its own
// local fake. These fakes exist only to assert the interface shape/contract
// -- no network call is made or possible yet (see README.md).

class FakeProspectingProvider implements ProspectingProvider {
  readonly name = "APOLLO" as const;
  discoverCalls: ProspectDiscoveryQuery[] = [];

  async discover(query: ProspectDiscoveryQuery): Promise<readonly DiscoveredProspect[]> {
    this.discoverCalls.push(query);
    return [
      {
        externalId: "apollo-1",
        companyName: "Acme Inc",
        companyDomain: "acme.test",
        contactName: "Jordan Rivera",
        contactEmail: "jordan@acme.test",
        contactTitle: "VP Engineering",
        industry: query.industry ?? null,
        companySizeHeadcount: 120,
      },
    ];
  }

  async enrich(externalId: string): Promise<ProspectEnrichmentResult> {
    return { externalId, fields: { linkedinUrl: null } };
  }
}

class FakeCrmProvider implements CrmProvider {
  readonly name = "HUBSPOT" as const;
  syncCalls: CrmSyncInput[] = [];

  async syncObject(input: CrmSyncInput): Promise<CrmSyncResult> {
    this.syncCalls.push(input);
    return {
      operationId: input.operationId,
      provider: "HUBSPOT",
      objectType: input.objectType,
      externalId: input.externalId ?? "hs-generated-1",
      status: "SYNCED",
    };
  }

  async listPipelineStages(_pipelineExternalId: string): Promise<readonly CrmPipelineStage[]> {
    return [{ externalId: "stage-1", label: "Prospecting", ordinal: 1 }];
  }
}

test("ProspectingProvider discovers prospects scoped to the requested query", async () => {
  const provider = new FakeProspectingProvider();
  const results = await provider.discover({
    operationId: "00000000-0000-4000-8000-000000000600",
    industry: "Software",
    limit: 10,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.companyName, "Acme Inc");
  assert.equal(provider.discoverCalls[0]?.operationId, "00000000-0000-4000-8000-000000000600");
});

test("ProspectingProvider enriches by external id", async () => {
  const provider = new FakeProspectingProvider();
  const result = await provider.enrich("apollo-1");
  assert.equal(result.externalId, "apollo-1");
});

test("CrmProvider syncs an object and echoes the operationId", async () => {
  const provider = new FakeCrmProvider();
  const result = await provider.syncObject({
    operationId: "00000000-0000-4000-8000-000000000601",
    objectType: "CONTACT",
    localId: "00000000-0000-4000-8000-000000000602",
    fields: { email: "jordan@acme.test" },
  });
  assert.equal(result.status, "SYNCED");
  assert.equal(result.provider, "HUBSPOT");
  assert.equal(provider.syncCalls.length, 1);
});

test("CrmProvider lists pipeline stages in ordinal order", async () => {
  const provider = new FakeCrmProvider();
  const stages = await provider.listPipelineStages("pipeline-1");
  assert.deepEqual(
    stages.map((stage) => stage.label),
    ["Prospecting"],
  );
});

test("RevenueProviderError carries a provider discriminant alongside code/retryable/cause", () => {
  const cause = new Error("upstream timeout");
  const error = new RevenueProviderError("Apollo discovery request failed", {
    provider: "APOLLO",
    code: "APOLLO_UNAVAILABLE",
    retryable: true,
    cause,
  });
  assert.equal(error.name, "RevenueProviderError");
  assert.equal(error.provider, "APOLLO");
  assert.equal(error.retryable, true);
  assert.equal(error.cause, cause);
});

import assert from "node:assert/strict";
import test from "node:test";

import type {
  CustomerSuccessHandoffRepository,
  DealReadyForHandoff,
  RecordHandoffResult,
} from "./customer-success-handoff-repository.js";
import { CustomerSuccessHandoffReconciler } from "./customer-success-handoff-reconciler.js";

const FIXED_NOW = new Date("2026-09-16T18:00:00.000Z");

const PLATFORM_DEAL: DealReadyForHandoff = {
  dealId: "00000000-0000-4000-8000-000000000001",
  gtmScopeId: "00000000-0000-4000-8000-000000000002",
  prospectId: "00000000-0000-4000-8000-000000000003",
  closedAt: new Date("2026-09-15T10:00:00.000Z"),
};

const PROJECT_DEAL: DealReadyForHandoff = {
  dealId: "00000000-0000-4000-8000-000000000004",
  gtmScopeId: "00000000-0000-4000-8000-000000000005",
  prospectId: "00000000-0000-4000-8000-000000000006",
  closedAt: new Date("2026-09-14T09:00:00.000Z"),
};

class FakeCustomerSuccessHandoffRepository
  implements CustomerSuccessHandoffRepository
{
  readonly #ready: DealReadyForHandoff[];
  readonly #recorded = new Set<string>();
  recordHandoffCalls: Array<{
    dealId: string;
    gtmScopeId: string;
    prospectId: string;
    now: Date;
  }> = [];

  constructor(ready: readonly DealReadyForHandoff[], alreadyRecorded: readonly string[] = []) {
    this.#ready = [...ready];
    for (const dealId of alreadyRecorded) {
      this.#recorded.add(dealId);
    }
  }

  async listDealsReadyForHandoff(): Promise<readonly DealReadyForHandoff[]> {
    return this.#ready.filter((deal) => !this.#recorded.has(deal.dealId));
  }

  async recordHandoff(
    dealId: string,
    gtmScopeId: string,
    prospectId: string,
    now: Date,
  ): Promise<RecordHandoffResult> {
    this.recordHandoffCalls.push({ dealId, gtmScopeId, prospectId, now });
    if (this.#recorded.has(dealId)) {
      return "already_exists";
    }
    this.#recorded.add(dealId);
    return "created";
  }
}

test("reconcile() with no deals ready creates nothing", async () => {
  const repository = new FakeCustomerSuccessHandoffRepository([]);
  const reconciler = new CustomerSuccessHandoffReconciler({
    repository,
    now: () => FIXED_NOW,
  });

  const summary = await reconciler.reconcile();

  assert.deepEqual(summary, { dealsScanned: 0, handoffsCreated: 0 });
  assert.equal(repository.recordHandoffCalls.length, 0);
});

test("reconcile() creates exactly one handoff for a single ready deal", async () => {
  const repository = new FakeCustomerSuccessHandoffRepository([PLATFORM_DEAL]);
  const reconciler = new CustomerSuccessHandoffReconciler({
    repository,
    now: () => FIXED_NOW,
  });

  const summary = await reconciler.reconcile();

  assert.deepEqual(summary, { dealsScanned: 1, handoffsCreated: 1 });
  assert.deepEqual(repository.recordHandoffCalls, [
    {
      dealId: PLATFORM_DEAL.dealId,
      gtmScopeId: PLATFORM_DEAL.gtmScopeId,
      prospectId: PLATFORM_DEAL.prospectId,
      now: FIXED_NOW,
    },
  ]);
});

test("reconcile() twice for the same deal never double-counts", async () => {
  const repository = new FakeCustomerSuccessHandoffRepository([PLATFORM_DEAL]);
  const reconciler = new CustomerSuccessHandoffReconciler({
    repository,
    now: () => FIXED_NOW,
  });

  const first = await reconciler.reconcile();
  assert.deepEqual(first, { dealsScanned: 1, handoffsCreated: 1 });

  const second = await reconciler.reconcile();

  assert.deepEqual(second, { dealsScanned: 0, handoffsCreated: 0 });
});

test("reconcile() handles a deal already recorded by a concurrent caller", async () => {
  const repository = new FakeCustomerSuccessHandoffRepository(
    [PLATFORM_DEAL],
    [PLATFORM_DEAL.dealId],
  );
  const reconciler = new CustomerSuccessHandoffReconciler({
    repository,
    now: () => FIXED_NOW,
  });

  const summary = await reconciler.reconcile();

  assert.deepEqual(summary, { dealsScanned: 0, handoffsCreated: 0 });
});

test("reconcile() processes deals across different GTM scopes independently", async () => {
  const repository = new FakeCustomerSuccessHandoffRepository([
    PLATFORM_DEAL,
    PROJECT_DEAL,
  ]);
  const reconciler = new CustomerSuccessHandoffReconciler({
    repository,
    now: () => FIXED_NOW,
  });

  const summary = await reconciler.reconcile();

  assert.deepEqual(summary, { dealsScanned: 2, handoffsCreated: 2 });
  const dealIds = repository.recordHandoffCalls.map((call) => call.dealId).sort();
  assert.deepEqual(
    dealIds,
    [PLATFORM_DEAL.dealId, PROJECT_DEAL.dealId].sort(),
  );
});

test("reconcile() defaults `now` to the current time when not provided", async () => {
  const repository = new FakeCustomerSuccessHandoffRepository([PLATFORM_DEAL]);
  const reconciler = new CustomerSuccessHandoffReconciler({ repository });

  const before = Date.now();
  await reconciler.reconcile();
  const after = Date.now();

  assert.equal(repository.recordHandoffCalls.length, 1);
  const recordedAt = repository.recordHandoffCalls[0]?.now.getTime() ?? 0;
  assert.ok(recordedAt >= before && recordedAt <= after);
});

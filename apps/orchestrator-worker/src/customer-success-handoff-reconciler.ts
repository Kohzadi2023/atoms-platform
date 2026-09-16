import type { CustomerSuccessHandoffRepository } from "./customer-success-handoff-repository.js";

export interface CustomerSuccessHandoffReconcilerOptions {
  readonly repository: CustomerSuccessHandoffRepository;
  readonly now?: () => Date;
}

export interface CustomerSuccessHandoffSummary {
  readonly dealsScanned: number;
  readonly handoffsCreated: number;
}

/**
 * Detection only: durably and idempotently records that a Deal reached
 * CLOSED_WON and is ready for a CustomerSuccess handoff. Does not invoke
 * any agent, create any AgentRun, or otherwise execute anything -- the
 * roadmap's CustomerSuccess trigger stops here until a later increment
 * designs how a non-project-scoped agent invocation can run (AgentRun.projectId
 * is required today, and a PLATFORM_GTM deal has no Project).
 */
export class CustomerSuccessHandoffReconciler {
  readonly #repository: CustomerSuccessHandoffRepository;
  readonly #now: () => Date;

  constructor(options: CustomerSuccessHandoffReconcilerOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
  }

  async reconcile(): Promise<CustomerSuccessHandoffSummary> {
    const deals = await this.#repository.listDealsReadyForHandoff();
    let handoffsCreated = 0;
    for (const deal of deals) {
      const result = await this.#repository.recordHandoff(
        deal.dealId,
        deal.gtmScopeId,
        deal.prospectId,
        this.#now(),
      );
      if (result === "created") {
        handoffsCreated += 1;
      }
    }
    return { dealsScanned: deals.length, handoffsCreated };
  }
}

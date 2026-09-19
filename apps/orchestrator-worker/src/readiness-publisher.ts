import {
  WORKER_READINESS_MAX_AGE_MS,
  WorkerReadinessReportSchema,
  type WorkerReadinessReport,
} from "@atoms/contracts";

export interface ReadinessStore {
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Facts read from the worker's own environment and code at startup. */
export interface WorkerReadinessFacts {
  readonly runBudgetUsdMicros: number;
  readonly workspaceDailyBudgetUsdMicros: number;
  readonly providerCredentialsPresent: boolean;
  /** SANDBOX_EGRESS_VERIFIED_AT: when an operator recorded a passing live probe. */
  readonly egressVerifiedAt: string | undefined;
  readonly attachmentContractVerified: boolean;
  readonly browserViabilityRequired: boolean;
}

const HEARTBEAT_MS = 30_000;
// Outlives one missed heartbeat; the reader also checks publishedAt, so the TTL
// only cleans up after a worker that is gone for good.
const TTL_SECONDS = Math.ceil((WORKER_READINESS_MAX_AGE_MS * 2) / 1_000);

export function buildWorkerReadinessReport(
  facts: WorkerReadinessFacts,
  now: Date,
): WorkerReadinessReport {
  const verifiedAt =
    facts.egressVerifiedAt === undefined ? Number.NaN : Date.parse(facts.egressVerifiedAt);
  return WorkerReadinessReportSchema.parse({
    version: 1,
    publishedAt: now.toISOString(),
    runBudgetConfigured: facts.runBudgetUsdMicros > 0,
    workspaceCeilingConfigured: facts.workspaceDailyBudgetUsdMicros > 0,
    providerCredentialsPresent: facts.providerCredentialsPresent,
    // A recorded probe counts only if it is a real date that is not in the future.
    egressVerified: Number.isFinite(verifiedAt) && verifiedAt <= now.getTime(),
    attachmentContractVerified: facts.attachmentContractVerified,
    browserViabilityRequired: facts.browserViabilityRequired,
  });
}

export interface WorkerReadinessPublisherOptions {
  readonly store: ReadinessStore;
  readonly key: string;
  readonly facts: WorkerReadinessFacts;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Publishes the worker's readiness for the Control API, which cannot see this
 * process's environment. A failed write is reported and retried on the next
 * beat; it never stops the worker, and a missing report reads as "not ready".
 */
export class WorkerReadinessPublisher {
  readonly #options: WorkerReadinessPublisherOptions;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: WorkerReadinessPublisherOptions) {
    this.#options = options;
  }

  async publishOnce(): Promise<void> {
    const report = buildWorkerReadinessReport(
      this.#options.facts,
      (this.#options.now ?? (() => new Date()))(),
    );
    try {
      await this.#options.store.set(this.#options.key, JSON.stringify(report), TTL_SECONDS);
    } catch (error) {
      this.#options.onError?.(error);
    }
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.publishOnce();
    this.#timer = setInterval(() => {
      void this.publishOnce();
    }, this.#options.intervalMs ?? HEARTBEAT_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

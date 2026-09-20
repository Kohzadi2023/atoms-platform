import type { Prisma, PrismaClient } from "@atoms/db";

export const APPROVAL_EXPIRED_CODE = "APPROVAL_EXPIRED";

export interface StalePausedRunRepository {
  /**
   * Cancels runs that have been PAUSED since before `pausedBefore` and returns the ids
   * it actually cancelled. Each run is changed by compare-and-set on its status and
   * control version, so a run that was resumed, approved or cancelled in the meantime,
   * or that another worker replica already expired, is left alone.
   */
  expirePausedRuns(input: {
    readonly pausedBefore: Date;
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly string[]>;
}

export class PrismaStalePausedRunRepository implements StalePausedRunRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async expirePausedRuns(input: {
    readonly pausedBefore: Date;
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly string[]> {
    const candidates = await this.#prisma.agentRun.findMany({
      where: {
        status: "PAUSED",
        pausedAt: { not: null, lt: input.pausedBefore },
      },
      select: { id: true, controlVersion: true },
      orderBy: { pausedAt: "asc" },
      take: input.limit,
    });

    const expired: string[] = [];
    for (const candidate of candidates) {
      const update = await this.#prisma.agentRun.updateMany({
        where: {
          id: candidate.id,
          status: "PAUSED",
          controlVersion: candidate.controlVersion,
        },
        data: {
          status: "CANCELLED",
          cancelledAt: input.now,
          controlVersion: { increment: 1 },
          error: expiredError() as Prisma.InputJsonValue,
        },
      });
      if (update.count === 1) expired.push(candidate.id);
    }
    return expired;
  }
}

// Shaped like the worker's other run errors, so the API returns it unchanged. A user's
// own cancel leaves `error` empty; this marker is how an expiry is told apart from it.
function expiredError() {
  return {
    code: APPROVAL_EXPIRED_CODE,
    name: "ApprovalExpired",
    message:
      "The run was paused longer than the allowed time and was cancelled. Start a new run to continue.",
    retryable: false,
  };
}

export interface ApprovalExpirySweeperOptions {
  readonly repository: StalePausedRunRepository;
  /** How long a run may stay PAUSED before it is cancelled. */
  readonly ttlMs: number;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly onExpired?: (runIds: readonly string[]) => void;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_BATCH_SIZE = 100;
// A backlog is worked off over several sweeps rather than in one unbounded loop.
const MAX_BATCHES_PER_SWEEP = 10;

/**
 * Cancels runs that have waited PAUSED for longer than the TTL. This only changes the
 * run's status: it does not delete the run's prompt, attachments, outputs or
 * checkpoint, so it is expiry, not data retention (docs/design-partner-runbook.md).
 * Any number of worker replicas can run it; the compare-and-set makes that safe.
 */
export class ApprovalExpirySweeper {
  readonly #options: ApprovalExpirySweeperOptions;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: ApprovalExpirySweeperOptions) {
    if (!Number.isInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive integer");
    }
    this.#options = options;
  }

  async sweepOnce(): Promise<number> {
    const batchSize = this.#options.batchSize ?? DEFAULT_BATCH_SIZE;
    const now = (this.#options.now ?? (() => new Date()))();
    const pausedBefore = new Date(now.getTime() - this.#options.ttlMs);
    let total = 0;
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
        const expired = await this.#options.repository.expirePausedRuns({
          pausedBefore,
          now,
          limit: batchSize,
        });
        if (expired.length > 0) {
          total += expired.length;
          this.#options.onExpired?.(expired);
        }
        // A short batch means the backlog is done. (A full batch that lost every
        // compare-and-set race also ends here; the next sweep picks it up.)
        if (expired.length < batchSize) break;
      }
    } catch (error) {
      this.#options.onError?.(error);
    }
    return total;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.sweepOnce();
    this.#timer = setInterval(() => {
      void this.sweepOnce();
    }, this.#options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

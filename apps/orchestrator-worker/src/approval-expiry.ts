import type { JsonValue, RunEventType } from "@atoms/contracts";
import { JsonValueSchema, validateRunEventPayload } from "@atoms/contracts";
import { Prisma, type PrismaClient } from "@atoms/db";

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

async function appendEvent(
  transaction: Prisma.TransactionClient,
  runId: string,
  eventType: RunEventType,
  payload: JsonValue,
): Promise<void> {
  const normalizedPayload = JsonValueSchema.parse(
    validateRunEventPayload(eventType, payload),
  );
  const run = await transaction.agentRun.update({
    where: { id: runId },
    data: { eventSequence: { increment: 1 } },
    select: { eventSequence: true },
  });
  await transaction.runEvent.create({
    data: {
      runId,
      sequence: run.eventSequence,
      eventType,
      payload: normalizedPayload as Prisma.InputJsonValue,
    },
  });
}

// --- G2 remainder: reminder (docs/adr/production-execution-gate.md, issue #100) ---

export interface PendingReminderRunRepository {
  /**
   * Records a reminder for runs that have been PAUSED since before
   * `pausedBefore` and have no reminder recorded yet. Returns the ids it
   * actually recorded. This is the full extent of "reminder" today: no email,
   * webhook or any other delivery channel exists anywhere in this platform,
   * so nothing is sent. A future notifier can watch run.approval_reminder_due
   * events; this only ever creates that record, once per run.
   */
  sendReminders(input: {
    readonly pausedBefore: Date;
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly string[]>;
}

export class PrismaPendingReminderRunRepository implements PendingReminderRunRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async sendReminders(input: {
    readonly pausedBefore: Date;
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly string[]> {
    const candidates = await this.#prisma.agentRun.findMany({
      where: {
        status: "PAUSED",
        pausedAt: { not: null, lt: input.pausedBefore },
        reminderSentAt: null,
      },
      select: { id: true, pausedAt: true },
      orderBy: { pausedAt: "asc" },
      take: input.limit,
    });

    const reminded: string[] = [];
    for (const candidate of candidates) {
      const recorded = await this.#prisma.$transaction(async (transaction) => {
        const update = await transaction.agentRun.updateMany({
          where: { id: candidate.id, status: "PAUSED", reminderSentAt: null },
          data: { reminderSentAt: input.now },
        });
        if (update.count !== 1) return false;
        await appendEvent(transaction, candidate.id, "run.approval_reminder_due", {
          version: "v1",
          pausedAt: (candidate.pausedAt ?? input.now).toISOString(),
        });
        return true;
      });
      if (recorded) reminded.push(candidate.id);
    }
    return reminded;
  }
}

export interface ApprovalReminderSweeperOptions {
  readonly repository: PendingReminderRunRepository;
  /** How long a run may stay PAUSED before a reminder is recorded for it. */
  readonly afterMs: number;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly onReminded?: (runIds: readonly string[]) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Records (never sends) a reminder for runs that have been PAUSED longer
 * than `afterMs`. Mirrors ApprovalExpirySweeper's shape and safety
 * properties (idempotent, safe under any number of replicas) but is a
 * separate class: they run on independent schedules and one having no TTL
 * configured must not disable the other.
 */
export class ApprovalReminderSweeper {
  readonly #options: ApprovalReminderSweeperOptions;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: ApprovalReminderSweeperOptions) {
    if (!Number.isInteger(options.afterMs) || options.afterMs <= 0) {
      throw new RangeError("afterMs must be a positive integer");
    }
    this.#options = options;
  }

  async sweepOnce(): Promise<number> {
    const batchSize = this.#options.batchSize ?? DEFAULT_BATCH_SIZE;
    const now = (this.#options.now ?? (() => new Date()))();
    const pausedBefore = new Date(now.getTime() - this.#options.afterMs);
    let total = 0;
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
        const reminded = await this.#options.repository.sendReminders({
          pausedBefore,
          now,
          limit: batchSize,
        });
        if (reminded.length > 0) {
          total += reminded.length;
          this.#options.onReminded?.(reminded);
        }
        if (reminded.length < batchSize) break;
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

// --- G2 remainder: data purge (design-partner-runbook.md's retention clause) ---

/** Not a secret; a human-readable marker left in place of redacted content. */
export const PURGE_REDACTION_MARKER =
  "[redacted: retention period elapsed -- see docs/design-partner-runbook.md]";

export interface ExpiredRunDataRepository {
  /**
   * Redacts the prompt, checkpoint and task input/output, and drops the
   * attachment links, of runs that expired (CANCELLED with
   * error.code === APPROVAL_EXPIRED) before `cancelledBefore` and have not
   * been purged yet. The run's own event log, including this purge's own
   * event, is left intact as an audit trail. Returns the ids it purged.
   */
  purgeExpiredRunData(input: {
    readonly cancelledBefore: Date;
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly string[]>;
}

export class PrismaExpiredRunDataRepository implements ExpiredRunDataRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async purgeExpiredRunData(input: {
    readonly cancelledBefore: Date;
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly string[]> {
    const candidates = await this.#prisma.agentRun.findMany({
      where: {
        status: "CANCELLED",
        purgedAt: null,
        cancelledAt: { not: null, lt: input.cancelledBefore },
        // Only runs this platform itself auto-cancelled on expiry -- never a
        // run the user cancelled themselves, which carries no error at all.
        error: { path: ["code"], equals: APPROVAL_EXPIRED_CODE },
      },
      select: { id: true, cancelledAt: true },
      orderBy: { cancelledAt: "asc" },
      take: input.limit,
    });

    const purgedIds: string[] = [];
    for (const candidate of candidates) {
      const done = await this.#prisma.$transaction(async (transaction) => {
        const update = await transaction.agentRun.updateMany({
          where: { id: candidate.id, status: "CANCELLED", purgedAt: null },
          data: {
            prompt: PURGE_REDACTION_MARKER,
            checkpoint: Prisma.DbNull,
            purgedAt: input.now,
          },
        });
        if (update.count !== 1) return false;
        await transaction.agentTask.updateMany({
          where: { runId: candidate.id },
          data: { input: Prisma.DbNull, output: Prisma.DbNull },
        });
        await transaction.agentRunAttachment.deleteMany({ where: { runId: candidate.id } });
        await appendEvent(transaction, candidate.id, "run.data_purged", {
          version: "v1",
          reason: "APPROVAL_EXPIRED",
          cancelledAt: (candidate.cancelledAt ?? input.now).toISOString(),
        });
        return true;
      });
      if (done) purgedIds.push(candidate.id);
    }
    return purgedIds;
  }
}

export interface RunDataPurgeSweeperOptions {
  readonly repository: ExpiredRunDataRepository;
  /** How long after expiry a run's data may be kept before it is redacted. */
  readonly afterMs: number;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly onPurged?: (runIds: readonly string[]) => void;
  readonly onError?: (error: unknown) => void;
}

/** Same shape and safety properties as ApprovalExpirySweeper and
 *  ApprovalReminderSweeper; a separate, independently scheduled class. */
export class RunDataPurgeSweeper {
  readonly #options: RunDataPurgeSweeperOptions;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: RunDataPurgeSweeperOptions) {
    if (!Number.isInteger(options.afterMs) || options.afterMs <= 0) {
      throw new RangeError("afterMs must be a positive integer");
    }
    this.#options = options;
  }

  async sweepOnce(): Promise<number> {
    const batchSize = this.#options.batchSize ?? DEFAULT_BATCH_SIZE;
    const now = (this.#options.now ?? (() => new Date()))();
    const cancelledBefore = new Date(now.getTime() - this.#options.afterMs);
    let total = 0;
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
        const purged = await this.#options.repository.purgeExpiredRunData({
          cancelledBefore,
          now,
          limit: batchSize,
        });
        if (purged.length > 0) {
          total += purged.length;
          this.#options.onPurged?.(purged);
        }
        if (purged.length < batchSize) break;
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

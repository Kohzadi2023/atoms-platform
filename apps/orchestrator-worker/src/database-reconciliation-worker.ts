import {
  DATABASE_RECONCILIATION_QUEUE_NAME,
  DATABASE_RECONCILIATION_SCHEDULER_ID,
  DatabaseReconciliationJobSchema,
  type DatabaseReconciliationJob,
} from "@atoms/contracts";
import { Queue, Worker } from "bullmq";

import type { DatabaseReconciler } from "./database-reconciler.js";
import {
  assertQueuePrefix,
  createQueueConnection,
  type QueueConnection,
  type QueueRedisMode,
} from "@atoms/queue-connection";

export interface BullMqDatabaseReconciliationWorkerOptions {
  readonly redisUrl: string;
  /** How the Redis is deployed; see @atoms/queue-connection. Defaults to standalone. */
  readonly redisMode?: QueueRedisMode;
  readonly reconciler: DatabaseReconciler;
  readonly intervalMs: number;
  readonly queueName?: string;
  readonly prefix?: string;
}

export class BullMqDatabaseReconciliationWorker {
  readonly #queueLink: QueueConnection;
  readonly #workerLink: QueueConnection;
  readonly #queue: Queue<DatabaseReconciliationJob>;
  readonly #worker: Worker<DatabaseReconciliationJob>;
  readonly #intervalMs: number;

  constructor(options: BullMqDatabaseReconciliationWorkerOptions) {
    const queueName = options.queueName ?? DATABASE_RECONCILIATION_QUEUE_NAME;
    assertQueuePrefix(options.redisMode, options.prefix);
    this.#queueLink = createQueueConnection({
      redisUrl: options.redisUrl,
      mode: options.redisMode,
      role: "queue",
    });
    this.#workerLink = createQueueConnection({
      redisUrl: options.redisUrl,
      mode: options.redisMode,
      role: "worker",
    });
    const prefix = options.prefix === undefined ? {} : { prefix: options.prefix };
    this.#intervalMs = options.intervalMs;
    this.#queue = new Queue<DatabaseReconciliationJob>(queueName, {
      connection: this.#queueLink.connection,
      ...prefix,
    });
    this.#worker = new Worker<DatabaseReconciliationJob>(
      queueName,
      async (job) => {
        DatabaseReconciliationJobSchema.parse(job.data);
        await options.reconciler.reconcile();
      },
      { connection: this.#workerLink.connection, ...prefix, concurrency: 1 },
    );
  }

  async start(): Promise<void> {
    await this.#queue.upsertJobScheduler(
      DATABASE_RECONCILIATION_SCHEDULER_ID,
      { every: this.#intervalMs },
      {
        name: "reconcile-generated-databases",
        data: { scope: "SUPABASE_MANAGED" },
        opts: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { age: 86_400, count: 500 },
          removeOnFail: { age: 604_800, count: 2_000 },
        },
      },
    );
  }

  onError(listener: (error: Error) => void): void {
    this.#worker.on("error", listener);
  }

  onFailed(listener: (jobId: string | undefined, error: Error) => void): void {
    this.#worker.on("failed", (job, error) => listener(job?.id, error));
  }

  async close(): Promise<void> {
    await this.#worker.close();
    await this.#queue.close();
    await this.#queueLink.close();
    await this.#workerLink.close();
  }
}

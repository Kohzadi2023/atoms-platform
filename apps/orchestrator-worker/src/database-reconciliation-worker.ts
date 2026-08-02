import {
  DATABASE_RECONCILIATION_QUEUE_NAME,
  DATABASE_RECONCILIATION_SCHEDULER_ID,
  DatabaseReconciliationJobSchema,
  type DatabaseReconciliationJob,
} from "@atoms/contracts";
import { Queue, Worker } from "bullmq";

import type { DatabaseReconciler } from "./database-reconciler.js";

export interface BullMqDatabaseReconciliationWorkerOptions {
  readonly redisUrl: string;
  readonly reconciler: DatabaseReconciler;
  readonly intervalMs: number;
  readonly queueName?: string;
  readonly prefix?: string;
}

export class BullMqDatabaseReconciliationWorker {
  readonly #queue: Queue<DatabaseReconciliationJob>;
  readonly #worker: Worker<DatabaseReconciliationJob>;
  readonly #intervalMs: number;

  constructor(options: BullMqDatabaseReconciliationWorkerOptions) {
    const queueName = options.queueName ?? DATABASE_RECONCILIATION_QUEUE_NAME;
    const connection = {
      url: options.redisUrl,
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
    };
    const queueConnection = { ...connection, maxRetriesPerRequest: 1 };
    const prefix = options.prefix === undefined ? {} : { prefix: options.prefix };
    this.#intervalMs = options.intervalMs;
    this.#queue = new Queue<DatabaseReconciliationJob>(queueName, {
      connection: queueConnection,
      ...prefix,
    });
    this.#worker = new Worker<DatabaseReconciliationJob>(
      queueName,
      async (job) => {
        DatabaseReconciliationJobSchema.parse(job.data);
        await options.reconciler.reconcile();
      },
      { connection, ...prefix, concurrency: 1 },
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
  }
}

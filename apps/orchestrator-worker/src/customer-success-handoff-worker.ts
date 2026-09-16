import { Queue, Worker } from "bullmq";

import type { CustomerSuccessHandoffReconciler } from "./customer-success-handoff-reconciler.js";

const QUEUE_NAME = "customer-success-handoff-reconciliation";
const SCHEDULER_ID = "customer-success-handoff-reconciliation-v1";

export interface BullMqCustomerSuccessHandoffWorkerOptions {
  readonly redisUrl: string;
  readonly reconciler: CustomerSuccessHandoffReconciler;
  readonly intervalMs: number;
  readonly queueName?: string;
  readonly prefix?: string;
}

export class BullMqCustomerSuccessHandoffWorker {
  readonly #queue: Queue<Record<string, never>>;
  readonly #worker: Worker<Record<string, never>>;
  readonly #intervalMs: number;

  constructor(options: BullMqCustomerSuccessHandoffWorkerOptions) {
    const queueName = options.queueName ?? QUEUE_NAME;
    const connection = {
      url: options.redisUrl,
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
    };
    const queueConnection = { ...connection, maxRetriesPerRequest: 1 };
    const prefix = options.prefix === undefined ? {} : { prefix: options.prefix };
    this.#intervalMs = options.intervalMs;
    this.#queue = new Queue<Record<string, never>>(queueName, {
      connection: queueConnection,
      ...prefix,
    });
    this.#worker = new Worker<Record<string, never>>(
      queueName,
      async () => {
        await options.reconciler.reconcile();
      },
      { connection, ...prefix, concurrency: 1 },
    );
  }

  async start(): Promise<void> {
    await this.#queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: this.#intervalMs },
      {
        name: "reconcile-customer-success-handoffs",
        data: {},
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

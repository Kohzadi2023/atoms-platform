import { RUN_QUEUE_NAME, RunJobSchema, type RunJob } from "@atoms/contracts";
import { Worker } from "bullmq";

import type { RunProcessor } from "./processor.js";

export interface BullMqOrchestratorWorkerOptions {
  readonly redisUrl: string;
  readonly processor: RunProcessor;
  readonly queueName?: string;
  readonly prefix?: string;
  readonly concurrency?: number;
}

export class BullMqOrchestratorWorker {
  readonly #worker: Worker<RunJob>;

  constructor(options: BullMqOrchestratorWorkerOptions) {
    this.#worker = new Worker<RunJob>(
      options.queueName ?? RUN_QUEUE_NAME,
      async (job) => {
        const data = RunJobSchema.parse(job.data);
        await options.processor.process(data, {
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 1,
        });
      },
      {
        connection: {
          url: options.redisUrl,
          enableOfflineQueue: false,
          maxRetriesPerRequest: null,
        },
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        concurrency: options.concurrency ?? 2,
      },
    );
  }

  onError(listener: (error: Error) => void): void {
    this.#worker.on("error", listener);
  }

  onFailed(listener: (jobId: string | undefined, error: Error) => void): void {
    this.#worker.on("failed", (job, error) => listener(job?.id, error));
  }

  close(): Promise<void> {
    return this.#worker.close();
  }
}

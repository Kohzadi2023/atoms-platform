import {
  DATABASE_OPERATION_QUEUE_NAME,
  DatabaseOperationJobSchema,
  type DatabaseOperationJob,
} from "@atoms/contracts";
import { Worker } from "bullmq";

import type { DatabaseOperationProcessor } from "./database-processor.js";

export interface BullMqDatabaseOperationWorkerOptions {
  readonly redisUrl: string;
  readonly processor: DatabaseOperationProcessor;
  readonly queueName?: string;
  readonly prefix?: string;
  readonly concurrency?: number;
}

export class BullMqDatabaseOperationWorker {
  readonly #worker: Worker<DatabaseOperationJob>;

  constructor(options: BullMqDatabaseOperationWorkerOptions) {
    this.#worker = new Worker<DatabaseOperationJob>(
      options.queueName ?? DATABASE_OPERATION_QUEUE_NAME,
      async (job) => {
        const data = DatabaseOperationJobSchema.parse(job.data);
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
        concurrency: options.concurrency ?? 1,
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

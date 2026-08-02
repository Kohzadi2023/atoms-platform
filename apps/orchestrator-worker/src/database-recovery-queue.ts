import {
  DATABASE_OPERATION_QUEUE_NAME,
  DatabaseOperationJobSchema,
  type DatabaseOperationJob,
} from "@atoms/contracts";
import { Queue } from "bullmq";

import type { DatabaseRecoveryQueue } from "./database-reconciliation-domain.js";

export interface BullMqDatabaseRecoveryQueueOptions {
  readonly redisUrl: string;
  readonly queueName?: string;
  readonly prefix?: string;
}

export class BullMqDatabaseRecoveryQueue implements DatabaseRecoveryQueue {
  readonly #queue: Queue<DatabaseOperationJob>;

  constructor(options: BullMqDatabaseRecoveryQueueOptions) {
    this.#queue = new Queue<DatabaseOperationJob>(
      options.queueName ?? DATABASE_OPERATION_QUEUE_NAME,
      {
        connection: {
          url: options.redisUrl,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        },
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: "exponential", delay: 2_000 },
          removeOnComplete: { age: 86_400, count: 1_000 },
          removeOnFail: { age: 604_800, count: 5_000 },
        },
      },
    );
  }

  async enqueue(untrustedJob: DatabaseOperationJob): Promise<void> {
    const job = DatabaseOperationJobSchema.parse(untrustedJob);
    await this.#queue.add("recover-database-operation", job, {
      jobId: `${job.operationId}-${job.command}-v${String(job.operationVersion)}`,
    });
  }

  close(): Promise<void> {
    return this.#queue.close();
  }
}

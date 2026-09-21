import { RUN_QUEUE_NAME, RunJobSchema, type RunJob } from "@atoms/contracts";
import { Worker } from "bullmq";

import type { RunProcessor } from "./processor.js";
import {
  assertQueuePrefix,
  createQueueConnection,
  type QueueConnection,
  type QueueRedisMode,
} from "@atoms/queue-connection";

export interface BullMqOrchestratorWorkerOptions {
  readonly redisUrl: string;
  /** How the Redis is deployed; see @atoms/queue-connection. Defaults to standalone. */
  readonly redisMode?: QueueRedisMode;
  readonly processor: RunProcessor;
  readonly queueName?: string;
  readonly prefix?: string;
  readonly concurrency?: number;
}

export class BullMqOrchestratorWorker {
  readonly #link: QueueConnection;
  readonly #worker: Worker<RunJob>;

  constructor(options: BullMqOrchestratorWorkerOptions) {
    assertQueuePrefix(options.redisMode, options.prefix);
    this.#link = createQueueConnection({
      redisUrl: options.redisUrl,
      mode: options.redisMode,
      role: "worker",
    });
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
        connection: this.#link.connection,
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

  async close(): Promise<void> {
    await this.#worker.close();
    await this.#link.close();
  }
}

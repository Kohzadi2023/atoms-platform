import {
  PREVIEW_REOPEN_QUEUE_NAME,
  PreviewReopenJobSchema,
  type PreviewReopenJob,
} from "@atoms/contracts";
import { Worker } from "bullmq";

import type { PreviewReopenProcessor } from "./preview-reopen.js";
import {
  assertQueuePrefix,
  createQueueConnection,
  type QueueConnection,
  type QueueRedisMode,
} from "@atoms/queue-connection";

export interface BullMqPreviewReopenWorkerOptions {
  readonly redisUrl: string;
  /** How the Redis is deployed; see @atoms/queue-connection. Defaults to standalone. */
  readonly redisMode?: QueueRedisMode;
  readonly processor: PreviewReopenProcessor;
  readonly queueName?: string;
  readonly prefix?: string;
  /** Each job holds a sandbox for minutes, so the default is one at a time. */
  readonly concurrency?: number;
}

export class BullMqPreviewReopenWorker {
  readonly #link: QueueConnection;
  readonly #worker: Worker<PreviewReopenJob>;

  constructor(options: BullMqPreviewReopenWorkerOptions) {
    assertQueuePrefix(options.redisMode, options.prefix);
    this.#link = createQueueConnection({
      redisUrl: options.redisUrl,
      mode: options.redisMode,
      role: "worker",
    });
    this.#worker = new Worker<PreviewReopenJob>(
      options.queueName ?? PREVIEW_REOPEN_QUEUE_NAME,
      async (job) => {
        await options.processor.process(PreviewReopenJobSchema.parse(job.data));
      },
      {
        connection: this.#link.connection,
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

  async close(): Promise<void> {
    await this.#worker.close();
    await this.#link.close();
  }
}

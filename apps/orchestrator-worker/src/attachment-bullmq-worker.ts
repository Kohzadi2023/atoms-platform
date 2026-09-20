import {
  ATTACHMENT_SCAN_QUEUE_NAME,
  AttachmentScanJobSchema,
  type AttachmentScanJob,
} from "@atoms/contracts";
import { Worker, type Job } from "bullmq";

import type { AttachmentProcessor } from "./attachment-processor.js";
import {
  assertQueuePrefix,
  createQueueConnection,
  type QueueConnection,
  type QueueRedisMode,
} from "@atoms/queue-connection";

export interface BullMqAttachmentWorkerOptions {
  readonly redisUrl: string;
  /** How the Redis is deployed; see @atoms/queue-connection. Defaults to standalone. */
  readonly redisMode?: QueueRedisMode;
  readonly processor: AttachmentProcessor;
  readonly concurrency?: number;
  readonly prefix?: string;
}

export class BullMqAttachmentWorker {
  readonly #link: QueueConnection;
  readonly #worker: Worker<AttachmentScanJob>;

  constructor(options: BullMqAttachmentWorkerOptions) {
    assertQueuePrefix(options.redisMode, options.prefix);
    this.#link = createQueueConnection({
      redisUrl: options.redisUrl,
      mode: options.redisMode,
      role: "worker",
    });
    this.#worker = new Worker<AttachmentScanJob>(
      ATTACHMENT_SCAN_QUEUE_NAME,
      async (job: Job<AttachmentScanJob>) => {
        const input = AttachmentScanJobSchema.parse(job.data);
        return options.processor.process(input, {
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 1,
        });
      },
      {
        connection: this.#link.connection,
        concurrency: options.concurrency ?? 2,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
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

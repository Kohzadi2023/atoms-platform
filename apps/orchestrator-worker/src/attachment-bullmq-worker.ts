import {
  ATTACHMENT_SCAN_QUEUE_NAME,
  AttachmentScanJobSchema,
  type AttachmentScanJob,
} from "@atoms/contracts";
import { Worker, type Job } from "bullmq";

import type { AttachmentProcessor } from "./attachment-processor.js";

export interface BullMqAttachmentWorkerOptions {
  readonly redisUrl: string;
  readonly processor: AttachmentProcessor;
  readonly concurrency?: number;
  readonly prefix?: string;
}

export class BullMqAttachmentWorker {
  readonly #worker: Worker<AttachmentScanJob>;

  constructor(options: BullMqAttachmentWorkerOptions) {
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
        connection: {
          url: options.redisUrl,
          enableOfflineQueue: false,
          maxRetriesPerRequest: null,
        },
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
  }
}

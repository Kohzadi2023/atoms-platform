import {
  ATTACHMENT_SCAN_QUEUE_NAME,
  type AttachmentScanJob,
} from "@atoms/contracts";
import { Queue } from "bullmq";

export interface AttachmentScanQueue {
  enqueue(job: AttachmentScanJob): Promise<void>;
  close(): Promise<void>;
}

export interface BullMqAttachmentScanQueueOptions {
  readonly redisUrl: string;
  readonly prefix?: string;
}

export class BullMqAttachmentScanQueue implements AttachmentScanQueue {
  readonly #queue: Queue<AttachmentScanJob>;

  constructor(options: BullMqAttachmentScanQueueOptions) {
    this.#queue = new Queue<AttachmentScanJob>(ATTACHMENT_SCAN_QUEUE_NAME, {
      connection: {
        url: options.redisUrl,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      },
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { age: 86_400, count: 1_000 },
        removeOnFail: { age: 604_800, count: 5_000 },
      },
    });
  }

  async enqueue(job: AttachmentScanJob): Promise<void> {
    await this.#queue.add("scan-attachment", job, {
      jobId: `${job.attachmentId}-${String(job.scanVersion)}`,
    });
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}

import {
  ATTACHMENT_SCAN_QUEUE_NAME,
  type AttachmentScanJob,
} from "@atoms/contracts";
import { Queue } from "bullmq";
import {
  assertQueuePrefix,
  createQueueConnection,
  type QueueConnection,
  type QueueRedisMode,
} from "@atoms/queue-connection";

export interface AttachmentScanQueue {
  enqueue(job: AttachmentScanJob): Promise<void>;
  close(): Promise<void>;
}

export interface BullMqAttachmentScanQueueOptions {
  readonly redisUrl: string;
  /** How the Redis is deployed; see @atoms/queue-connection. Defaults to standalone. */
  readonly redisMode?: QueueRedisMode;
  readonly prefix?: string;
}

export class BullMqAttachmentScanQueue implements AttachmentScanQueue {
  readonly #link: QueueConnection;
  readonly #queue: Queue<AttachmentScanJob>;

  constructor(options: BullMqAttachmentScanQueueOptions) {
    assertQueuePrefix(options.redisMode, options.prefix);
    this.#link = createQueueConnection({
      redisUrl: options.redisUrl,
      mode: options.redisMode,
      role: "queue",
    });
    this.#queue = new Queue<AttachmentScanJob>(ATTACHMENT_SCAN_QUEUE_NAME, {
      connection: this.#link.connection,
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
    await this.#link.close();
  }
}

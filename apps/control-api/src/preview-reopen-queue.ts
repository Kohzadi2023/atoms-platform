import {
  PREVIEW_REOPEN_QUEUE_NAME,
  PreviewReopenJobSchema,
  type PreviewReopenJob,
} from "@atoms/contracts";
import { Queue } from "bullmq";
import {
  assertQueuePrefix,
  createQueueConnection,
  type QueueConnection,
  type QueueRedisMode,
} from "@atoms/queue-connection";

export interface PreviewReopenQueue {
  enqueue(job: PreviewReopenJob): Promise<void>;
  close(): Promise<void>;
}

export interface BullMqPreviewReopenQueueOptions {
  readonly redisUrl: string;
  /** How the Redis is deployed; see @atoms/queue-connection. Defaults to standalone. */
  readonly redisMode?: QueueRedisMode;
  readonly queueName?: string;
  readonly prefix?: string;
}

export class BullMqPreviewReopenQueue implements PreviewReopenQueue {
  readonly #link: QueueConnection;
  readonly #queue: Queue<PreviewReopenJob>;

  constructor(options: BullMqPreviewReopenQueueOptions) {
    assertQueuePrefix(options.redisMode, options.prefix);
    this.#link = createQueueConnection({
      redisUrl: options.redisUrl,
      mode: options.redisMode,
      role: "queue",
    });
    this.#queue = new Queue<PreviewReopenJob>(
      options.queueName ?? PREVIEW_REOPEN_QUEUE_NAME,
      {
        connection: this.#link.connection,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        defaultJobOptions: {
          // The processor records its own failures and never throws, so a retry
          // would only rebuild the same sandbox. Finished jobs are removed so the
          // per-project job id is free again for the next request.
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      },
    );
  }

  async enqueue(untrustedJob: PreviewReopenJob): Promise<void> {
    const job = PreviewReopenJobSchema.parse(untrustedJob);
    // One re-open per project at a time: while a job with this id is waiting or
    // running, BullMQ ignores a second add with the same id.
    await this.#queue.add("reopen-preview", job, {
      jobId: `reopen-${job.projectId}`,
    });
  }

  async close(): Promise<void> {
    await this.#queue.close();
    await this.#link.close();
  }
}

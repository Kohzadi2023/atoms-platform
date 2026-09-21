import { Queue } from "bullmq";

import { RUN_QUEUE_NAME } from "@atoms/contracts";

import type { RunJob } from "./domain.js";
import {
  assertQueuePrefix,
  createQueueConnection,
  type QueueConnection,
  type QueueRedisMode,
} from "@atoms/queue-connection";

export const DEFAULT_RUN_QUEUE_NAME = RUN_QUEUE_NAME;

export interface RunQueue {
  enqueue(job: RunJob): Promise<void>;
  close(): Promise<void>;
}

export interface BullMqRunQueueOptions {
  readonly redisUrl: string;
  /** How the Redis is deployed; see @atoms/queue-connection. Defaults to standalone. */
  readonly redisMode?: QueueRedisMode;
  readonly queueName?: string;
  readonly prefix?: string;
}

export class BullMqRunQueue implements RunQueue {
  readonly #link: QueueConnection;
  readonly #queue: Queue<RunJob>;

  constructor(options: BullMqRunQueueOptions) {
    assertQueuePrefix(options.redisMode, options.prefix);
    this.#link = createQueueConnection({
      redisUrl: options.redisUrl,
      mode: options.redisMode,
      role: "queue",
    });
    this.#queue = new Queue<RunJob>(
      options.queueName ?? DEFAULT_RUN_QUEUE_NAME,
      {
        connection: this.#link.connection,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 1_000 },
          removeOnComplete: { age: 86_400, count: 1_000 },
          removeOnFail: { age: 604_800, count: 5_000 },
        },
      },
    );
  }

  async enqueue(job: RunJob): Promise<void> {
    await this.#queue.add("execute-run", job, {
      jobId: `${job.runId}-${job.command}-${String(job.controlVersion)}`,
    });
  }

  async close(): Promise<void> {
    await this.#queue.close();
    await this.#link.close();
  }
}

import {
  DATABASE_OPERATION_QUEUE_NAME,
  DatabaseOperationJobSchema,
  type DatabaseOperationJob,
} from "@atoms/contracts";
import { Queue } from "bullmq";
import {
  assertQueuePrefix,
  createQueueConnection,
  type QueueConnection,
  type QueueRedisMode,
} from "@atoms/queue-connection";

export interface DatabaseOperationQueue {
  enqueue(job: DatabaseOperationJob): Promise<void>;
  close(): Promise<void>;
}

export interface BullMqDatabaseOperationQueueOptions {
  readonly redisUrl: string;
  /** How the Redis is deployed; see @atoms/queue-connection. Defaults to standalone. */
  readonly redisMode?: QueueRedisMode;
  readonly queueName?: string;
  readonly prefix?: string;
}

export class BullMqDatabaseOperationQueue implements DatabaseOperationQueue {
  readonly #link: QueueConnection;
  readonly #queue: Queue<DatabaseOperationJob>;

  constructor(options: BullMqDatabaseOperationQueueOptions) {
    assertQueuePrefix(options.redisMode, options.prefix);
    this.#link = createQueueConnection({
      redisUrl: options.redisUrl,
      mode: options.redisMode,
      role: "queue",
    });
    this.#queue = new Queue<DatabaseOperationJob>(
      options.queueName ?? DATABASE_OPERATION_QUEUE_NAME,
      {
        connection: this.#link.connection,
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
    await this.#queue.add("execute-database-operation", job, {
      jobId: `${job.operationId}-${job.command}-v${String(job.operationVersion)}`,
    });
  }

  async close(): Promise<void> {
    await this.#queue.close();
    await this.#link.close();
  }
}

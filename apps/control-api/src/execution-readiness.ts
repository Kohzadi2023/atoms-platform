import {
  WorkerReadinessReportSchema,
  evaluateExecutionReadiness,
  workerReadinessKey,
  type ExecutionReadiness,
  type WorkerReadinessReport,
} from "@atoms/contracts";
import { Redis } from "ioredis";

export interface WorkerReadinessSource {
  read(): Promise<WorkerReadinessReport | null>;
  close?(): Promise<void>;
}

export interface ExecutionReadinessProvider {
  current(): Promise<ExecutionReadiness>;
  close?(): Promise<void>;
}

export interface RedisWorkerReadinessSourceOptions {
  readonly redisUrl: string;
  readonly prefix?: string;
  readonly timeoutMs?: number;
}

/**
 * Reads the report the worker publishes (see the worker's readiness publisher).
 * Anything unexpected reads as "no report": a broken channel must look not-ready,
 * never ready.
 */
export class RedisWorkerReadinessSource implements WorkerReadinessSource {
  readonly #redis: Redis;
  readonly #key: string;
  readonly #timeoutMs: number;

  constructor(options: RedisWorkerReadinessSourceOptions) {
    this.#redis = new Redis(options.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    // Connection errors surface through read(); without a listener ioredis logs them noisily.
    this.#redis.on("error", () => undefined);
    this.#key = workerReadinessKey(options.prefix);
    this.#timeoutMs = options.timeoutMs ?? 300;
  }

  async read(): Promise<WorkerReadinessReport | null> {
    try {
      const raw = await Promise.race([
        this.#redis.get(this.#key),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), this.#timeoutMs).unref()),
      ]);
      if (raw === null) return null;
      const parsed = WorkerReadinessReportSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    this.#redis.disconnect();
  }
}

export interface ExecutionReadinessServiceOptions {
  readonly source: WorkerReadinessSource | undefined;
  readonly controlPlaneEnabled: boolean;
  readonly now?: () => Date;
  /** Probes hit /readyz often; the cache keeps that from becoming a Redis read each time. */
  readonly cacheMs?: number;
}

export class ExecutionReadinessService implements ExecutionReadinessProvider {
  readonly #options: ExecutionReadinessServiceOptions;
  #cached: { readonly at: number; readonly value: ExecutionReadiness } | undefined;

  constructor(options: ExecutionReadinessServiceOptions) {
    this.#options = options;
  }

  async current(): Promise<ExecutionReadiness> {
    const now = this.#options.now ?? (() => new Date());
    const nowMs = now().getTime();
    const cacheMs = this.#options.cacheMs ?? 5_000;
    if (this.#cached !== undefined && nowMs - this.#cached.at < cacheMs) {
      return this.#cached.value;
    }
    // A failing channel reads as "no report", so /readyz stays 200 and shows not ready.
    const worker = await Promise.resolve(this.#options.source?.read())
      .then((report) => report ?? null)
      .catch(() => null);
    const value = evaluateExecutionReadiness({
      controlPlaneEnabled: this.#options.controlPlaneEnabled,
      worker,
      now: now(),
    });
    this.#cached = { at: nowMs, value };
    return value;
  }

  async close(): Promise<void> {
    await this.#options.source?.close?.();
  }
}

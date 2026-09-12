import { isIP } from "node:net";

import { Cluster, Redis, type ClusterOptions } from "ioredis";
import { z } from "zod";

export const PreviewRedisModeSchema = z
  .enum(["standalone", "oss-cluster"])
  .default("standalone");
export type PreviewRedisMode = z.infer<typeof PreviewRedisModeSchema>;

/** Parse locally; never infer a provider's clustering policy from its hostname. */
export function previewRedisClusterConfiguration(redisUrl: string) {
  try {
    const url = new URL(redisUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || 6_379);
    if (
      !["redis:", "rediss:"].includes(url.protocol) ||
      host.length === 0 || port < 1 || port > 65_535 ||
      !["", "/", "/0"].includes(url.pathname) || url.search || url.hash
    ) {
      throw new TypeError();
    }
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    return {
      nodes: [{ host, port }],
      options: {
        enableOfflineQueue: false,
        enableReadyCheck: true,
        maxRedirections: 8,
        slotsRefreshTimeout: 5_000,
        // Keep DNS names intact for TLS; ioredis discovers shard ports itself.
        dnsLookup: (address, callback) => callback(null, address),
        redisOptions: {
          db: 0,
          connectTimeout: 5_000,
          commandTimeout: 5_000,
          maxRetriesPerRequest: 1,
          ...(username === undefined ? {} : { username }),
          ...(password === undefined ? {} : { password }),
          ...(url.protocol === "rediss:" ? {
            tls: { rejectUnauthorized: true, ...(isIP(host) ? {} : { servername: host }) },
          } : {}),
        },
      },
    } satisfies { nodes: { host: string; port: number }[]; options: ClusterOptions };
  } catch {
    // URL/decode errors may contain credentials. Only a fixed message escapes.
    throw new TypeError("Invalid preview Redis cluster configuration");
  }
}

const HeaderRecordSchema = z.record(
  z.string().trim().min(1).max(128),
  z.string().max(8_192),
);

export const PreviewTargetSchema = z
  .object({
    sessionId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    projectId: z.string().uuid(),
    runId: z.string().uuid(),
    upstreamUrl: z
      .string()
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
        message: "upstreamUrl must use HTTP or HTTPS",
      }),
    requestHeaders: HeaderRecordSchema,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type PreviewTarget = z.infer<typeof PreviewTargetSchema>;

export interface PreviewSessionStore {
  put(target: PreviewTarget): Promise<void>;
  get(sessionId: string): Promise<PreviewTarget | null>;
  delete(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface RedisPreviewClient {
  set(
    key: string,
    value: string,
    mode: "PX",
    milliseconds: number,
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect?(): void;
}

export interface RedisPreviewSessionStoreOptions {
  readonly redisUrl?: string;
  readonly redisMode?: PreviewRedisMode;
  readonly client?: RedisPreviewClient;
  readonly keyPrefix?: string;
  readonly now?: () => Date;
}

export class RedisPreviewSessionStore implements PreviewSessionStore {
  readonly #client: RedisPreviewClient;
  readonly #ownsClient: boolean;
  readonly #keyPrefix: string;
  readonly #now: () => Date;

  constructor(options: RedisPreviewSessionStoreOptions) {
    if (options.client === undefined && options.redisUrl === undefined) {
      throw new TypeError("redisUrl is required when no Redis client is supplied");
    }
    const mode = PreviewRedisModeSchema.parse(options.redisMode);
    if (options.client !== undefined) {
      this.#client = options.client;
    } else if (mode === "oss-cluster") {
      const configuration = previewRedisClusterConfiguration(options.redisUrl as string);
      this.#client = new Cluster(configuration.nodes, configuration.options);
    } else {
      this.#client = new Redis(options.redisUrl as string, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
    }
    this.#ownsClient = options.client === undefined;
    this.#keyPrefix = options.keyPrefix ?? "atoms:preview:";
    this.#now = options.now ?? (() => new Date());
  }

  async put(target: PreviewTarget): Promise<void> {
    const parsed = PreviewTargetSchema.parse(target);
    const ttlMs = new Date(parsed.expiresAt).getTime() - this.#now().getTime();
    if (ttlMs <= 0) {
      throw new RangeError("Cannot store an expired preview target");
    }
    await this.#client.set(
      this.#key(parsed.sessionId),
      JSON.stringify(parsed),
      "PX",
      ttlMs,
    );
  }

  async get(sessionId: string): Promise<PreviewTarget | null> {
    const parsedId = z.string().uuid().parse(sessionId);
    const value = await this.#client.get(this.#key(parsedId));
    if (value === null) return null;
    const target = PreviewTargetSchema.parse(JSON.parse(value) as unknown);
    if (new Date(target.expiresAt).getTime() <= this.#now().getTime()) {
      await this.delete(parsedId);
      return null;
    }
    return target;
  }

  async delete(sessionId: string): Promise<void> {
    const parsedId = z.string().uuid().parse(sessionId);
    await this.#client.del(this.#key(parsedId));
  }

  async close(): Promise<void> {
    if (this.#ownsClient) {
      try {
        await this.#client.quit();
      } finally {
        this.#client.disconnect?.();
      }
    }
  }

  #key(sessionId: string): string {
    return `${this.#keyPrefix}${sessionId}`;
  }
}

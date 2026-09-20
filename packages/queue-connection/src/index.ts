import { isIP } from "node:net";

import type { ConnectionOptions } from "bullmq";
import { Cluster, Redis, type ClusterOptions } from "ioredis";
import { z } from "zod";

/**
 * How the Redis behind the queues is deployed.
 * - standalone: one endpoint, any client (a local Redis, or a provider policy that hides the shards).
 * - oss-cluster: Redis Cluster that a client must follow itself. Azure Managed Redis with the
 *   OSS clustering policy is this. Never infer it from a hostname; it is configured.
 */
export const QueueRedisModeSchema = z.enum(["standalone", "oss-cluster"]).default("standalone");
export type QueueRedisMode = z.infer<typeof QueueRedisModeSchema>;

/** A queue only adds and reads jobs. A worker also blocks waiting for them. */
export type QueueConnectionRole = "queue" | "worker";

export interface QueueConnection {
  readonly connection: ConnectionOptions;
  /** Releases a connection this object created. A no-op for standalone options. */
  close(): Promise<void>;
}

export interface QueueConnectionOptions {
  readonly redisUrl: string;
  readonly mode?: QueueRedisMode | undefined;
  readonly role: QueueConnectionRole;
}

/**
 * The connection to hand to a BullMQ Queue or Worker.
 *
 * Standalone returns exactly the options the queues always used, so nothing changes unless
 * the mode is set. In oss-cluster mode it returns an ioredis Cluster: a plain connection to a
 * cluster fails with `MOVED`, because it cannot follow the redirects between shards.
 */
export function createQueueConnection(options: QueueConnectionOptions): QueueConnection {
  const mode = QueueRedisModeSchema.parse(options.mode);
  if (mode === "standalone") {
    return {
      connection: {
        url: options.redisUrl,
        enableOfflineQueue: false,
        maxRetriesPerRequest: options.role === "worker" ? null : 1,
      },
      close: async () => undefined,
    };
  }

  const configuration = queueClusterConfiguration(options.redisUrl, options.role);
  const cluster = new Cluster(configuration.nodes, configuration.options);
  return {
    connection: cluster,
    close: async () => {
      cluster.disconnect();
    },
  };
}

/**
 * A plain Redis client for single-key commands (GET, SET, ...) that follows the same mode as
 * the queues. A standalone client against an OSS cluster fails with MOVED for any key that
 * lives on another shard, so anything reading or writing keys next to the queues needs this too.
 * `offlineQueue` keeps commands issued before the connection is up waiting instead of failing.
 */
export function createRedisClient(options: {
  readonly redisUrl: string;
  readonly mode?: QueueRedisMode | undefined;
  readonly offlineQueue?: boolean;
}): Redis | Cluster {
  const offlineQueue = options.offlineQueue ?? false;
  if (QueueRedisModeSchema.parse(options.mode) === "oss-cluster") {
    const configuration = queueClusterConfiguration(options.redisUrl, "queue");
    return new Cluster(configuration.nodes, {
      ...configuration.options,
      enableOfflineQueue: offlineQueue,
    });
  }
  return new Redis(options.redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: offlineQueue,
  });
}

/**
 * In cluster mode every key of a queue must hash to one slot, because BullMQ's Lua scripts
 * touch several keys at once. A hash tag in the prefix (`{atoms-staging}`) forces that.
 * Without it Redis rejects every script with `CROSSSLOT`.
 */
export function assertQueuePrefix(
  mode: QueueRedisMode | undefined,
  prefix: string | undefined,
): void {
  if (QueueRedisModeSchema.parse(mode) !== "oss-cluster") return;
  if (prefix === undefined || !/\{[^{}]+\}/.test(prefix)) {
    throw new TypeError(
      'QUEUE_REDIS_MODE=oss-cluster requires RUN_QUEUE_PREFIX to contain a hash tag, for example "{atoms-staging}"; without one every queue command fails with CROSSSLOT',
    );
  }
}

/** Parsed locally; a URL or decode error can carry credentials, so only a fixed message escapes. */
export function queueClusterConfiguration(redisUrl: string, role: QueueConnectionRole) {
  try {
    const url = new URL(redisUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || 6_379);
    if (
      !["redis:", "rediss:"].includes(url.protocol) ||
      host.length === 0 ||
      port < 1 ||
      port > 65_535 ||
      !["", "/", "/0"].includes(url.pathname) ||
      url.search ||
      url.hash
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
        // Keep DNS names intact for TLS; ioredis discovers the shard addresses itself.
        dnsLookup: (address, callback) => callback(null, address),
        redisOptions: {
          db: 0,
          connectTimeout: 5_000,
          // A worker waits on blocking commands (BZPOPMIN), so it must neither retry-limit nor
          // time out commands; a queue used by the API should fail fast instead.
          maxRetriesPerRequest: role === "worker" ? null : 1,
          ...(username === undefined ? {} : { username }),
          ...(password === undefined ? {} : { password }),
          ...(url.protocol === "rediss:"
            ? {
                tls: {
                  rejectUnauthorized: true,
                  ...(isIP(host) ? {} : { servername: host }),
                },
              }
            : {}),
        },
      },
    } satisfies { nodes: { host: string; port: number }[]; options: ClusterOptions };
  } catch {
    throw new TypeError("Invalid queue Redis cluster configuration");
  }
}

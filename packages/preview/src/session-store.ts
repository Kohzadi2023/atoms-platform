import { Redis } from "ioredis";
import { z } from "zod";

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
}

export interface RedisPreviewSessionStoreOptions {
  readonly redisUrl?: string;
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
    this.#client =
      options.client ??
      new Redis(options.redisUrl as string, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
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
    if (this.#ownsClient) await this.#client.quit();
  }

  #key(sessionId: string): string {
    return `${this.#keyPrefix}${sessionId}`;
  }
}

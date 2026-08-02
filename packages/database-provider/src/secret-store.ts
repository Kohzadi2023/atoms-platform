import { randomUUID } from "node:crypto";

import { z } from "zod";

import { SecretStoreError } from "./errors.js";
import type {
  DatabaseConnectionScope,
  SecretLease,
  SecretStore,
} from "./types.js";

interface StoredSecret {
  readonly value: string;
  readonly expiresAt?: string;
}

export class InMemorySecretStore implements SecretStore {
  readonly #values = new Map<string, StoredSecret>();
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  referenceForKey(key: string): string {
    return `memory://${normalizeKey(key)}`;
  }

  async put(
    key: string,
    value: string,
    options: { readonly expiresAt?: string } = {},
  ): Promise<string> {
    const normalized = normalizeKey(key);
    const reference = this.referenceForKey(normalized);
    this.#values.set(reference, {
      value,
      ...(options.expiresAt === undefined
        ? {}
        : { expiresAt: options.expiresAt }),
    });
    return reference;
  }

  async get(reference: string): Promise<string> {
    const secret = this.#values.get(reference);
    if (secret === undefined) {
      throw new SecretStoreError("Secret reference was not found", {
        code: "SECRET_NOT_FOUND",
        retryable: false,
      });
    }
    if (
      secret.expiresAt !== undefined &&
      new Date(secret.expiresAt).getTime() <= this.#now().getTime()
    ) {
      this.#values.delete(reference);
      throw new SecretStoreError("Secret reference has expired", {
        code: "SECRET_EXPIRED",
        retryable: false,
      });
    }
    return secret.value;
  }

  async createLease(
    sourceReference: string,
    scope: DatabaseConnectionScope,
    ttlMs: number,
  ): Promise<SecretLease> {
    assertLeaseTtl(ttlMs);
    const value = await this.get(sourceReference);
    const expiresAt = new Date(this.#now().getTime() + ttlMs).toISOString();
    const reference = await this.put(
      `leases/${scope}/${randomUUID()}`,
      value,
      { expiresAt },
    );
    return { reference, expiresAt };
  }

  async revoke(reference: string): Promise<void> {
    this.#values.delete(reference);
  }
}

const VaultReadResponseSchema = z
  .object({
    data: z
      .object({
        data: z
          .object({
            value: z.string(),
            expiresAt: z.string().datetime({ offset: true }).optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export interface VaultSecretStoreOptions {
  readonly address: string;
  readonly token: string;
  readonly mount?: string;
  readonly namespace?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/** HashiCorp Vault KV v2 adapter. Secret values never enter PostgreSQL. */
export class VaultSecretStore implements SecretStore {
  readonly #address: string;
  readonly #token: string;
  readonly #mount: string;
  readonly #namespace: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: VaultSecretStoreOptions) {
    this.#address = new URL(options.address).toString().replace(/\/$/, "");
    this.#token = z.string().min(1).parse(options.token);
    this.#mount = normalizeKey(options.mount ?? "secret");
    this.#namespace = options.namespace;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  referenceForKey(key: string): string {
    return `vault://${this.#mount}/${normalizeKey(key)}`;
  }

  async put(
    key: string,
    value: string,
    options: { readonly expiresAt?: string } = {},
  ): Promise<string> {
    const normalized = normalizeKey(key);
    await this.#request("POST", "data", normalized, {
      data: {
        value,
        ...(options.expiresAt === undefined
          ? {}
          : { expiresAt: options.expiresAt }),
      },
    });
    return this.referenceForKey(normalized);
  }

  async get(reference: string): Promise<string> {
    const key = this.#parseReference(reference);
    const response = await this.#request("GET", "data", key);
    const parsed = VaultReadResponseSchema.parse(response);
    const secret = parsed.data.data;
    if (
      secret.expiresAt !== undefined &&
      new Date(secret.expiresAt).getTime() <= this.#now().getTime()
    ) {
      await this.revoke(reference);
      throw new SecretStoreError("Secret reference has expired", {
        code: "SECRET_EXPIRED",
        retryable: false,
      });
    }
    return secret.value;
  }

  async createLease(
    sourceReference: string,
    scope: DatabaseConnectionScope,
    ttlMs: number,
  ): Promise<SecretLease> {
    assertLeaseTtl(ttlMs);
    const value = await this.get(sourceReference);
    const expiresAt = new Date(this.#now().getTime() + ttlMs).toISOString();
    const reference = await this.put(
      `leases/${scope}/${randomUUID()}`,
      value,
      { expiresAt },
    );
    return { reference, expiresAt };
  }

  async revoke(reference: string): Promise<void> {
    const key = this.#parseReference(reference);
    await this.#request("DELETE", "metadata", key, undefined, true);
  }

  async #request(
    method: "GET" | "POST" | "DELETE",
    area: "data" | "metadata",
    key: string,
    body?: unknown,
    ignoreNotFound = false,
  ): Promise<unknown> {
    const path = key.split("/").map(encodeURIComponent).join("/");
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#address}/v1/${encodeURIComponent(this.#mount)}/${area}/${path}`,
        {
          method,
          headers: {
            "X-Vault-Token": this.#token,
            ...(this.#namespace === undefined
              ? {}
              : { "X-Vault-Namespace": this.#namespace }),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    } catch (error) {
      throw new SecretStoreError("Secret store request failed", {
        code: "SECRET_STORE_UNAVAILABLE",
        retryable: true,
        cause: error,
      });
    }
    if (ignoreNotFound && response.status === 404) return {};
    if (!response.ok) {
      throw new SecretStoreError(
        `Secret store request failed with HTTP ${String(response.status)}`,
        {
          code: response.status >= 500 ? "SECRET_STORE_UNAVAILABLE" : "SECRET_STORE_REJECTED",
          retryable: response.status === 429 || response.status >= 500,
        },
      );
    }
    if (response.status === 204) return {};
    return response.json();
  }

  #parseReference(reference: string): string {
    let parsed: URL;
    try {
      parsed = new URL(reference);
    } catch (error) {
      throw new SecretStoreError("Malformed secret reference", {
        code: "INVALID_SECRET_REFERENCE",
        retryable: false,
        cause: error,
      });
    }
    if (parsed.protocol !== "vault:" || parsed.hostname !== this.#mount) {
      throw new SecretStoreError("Secret reference belongs to another store", {
        code: "INVALID_SECRET_REFERENCE",
        retryable: false,
      });
    }
    return normalizeKey(decodeURIComponent(parsed.pathname.replace(/^\//, "")));
  }
}

function normalizeKey(value: string): string {
  const normalized = z
    .string()
    .trim()
    .min(1)
    .max(400)
    .regex(/^[a-zA-Z0-9._/-]+$/)
    .parse(value)
    .replace(/^\/+|\/+$/g, "");
  if (normalized.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new SecretStoreError("Secret key contains an invalid segment", {
      code: "INVALID_SECRET_KEY",
      retryable: false,
    });
  }
  return normalized;
}

function assertLeaseTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 3_600_000) {
    throw new RangeError("Secret lease TTL must be between one minute and one hour");
  }
}

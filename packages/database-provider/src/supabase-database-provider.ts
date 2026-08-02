import { randomBytes } from "node:crypto";

import { z } from "zod";

import { DatabaseProviderError, SecretStoreError } from "./errors.js";
import type {
  DatabaseConnectionScope,
  DatabaseHealthStatus,
  ManagedDatabaseResource,
  DatabaseProvider,
  DatabaseProvisionInput,
  DatabaseProvisionResult,
  SecretLease,
  SecretStore,
} from "./types.js";

const ProvisionInputSchema = z
  .object({
    operationId: z.string().uuid(),
    projectId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(160),
    region: z.enum(["americas", "emea", "apac"]),
  })
  .strict();

const SupabaseProjectSchema = z
  .object({
    id: z.string().trim().min(1).max(191).optional(),
    ref: z.string().trim().min(1).max(191).optional(),
    name: z.string().trim().min(1).max(160),
    organization_slug: z.string().trim().min(1).max(191).optional(),
    region: z.string().trim().min(1).max(80).optional(),
    status: z.string().trim().min(1).max(100).optional(),
    created_at: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough()
  .refine((value) => value.ref !== undefined || value.id !== undefined, {
    message: "Supabase project response is missing its reference",
  });

const SupabaseProjectsSchema = z.array(SupabaseProjectSchema);

const SupabaseHealthServiceSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    status: z.string().trim().min(1).max(100),
  })
  .passthrough();

const SupabaseHealthSchema = z.union([
  z.array(SupabaseHealthServiceSchema),
  z
    .object({ services: z.array(SupabaseHealthServiceSchema) })
    .passthrough()
    .transform((value) => value.services),
]);

export interface SupabaseDatabaseProviderOptions {
  readonly accessToken: string;
  readonly organizationSlug: string;
  readonly secretStore: SecretStore;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly migrationLeaseTtlMs?: number;
  readonly runtimeLeaseTtlMs?: number;
}

export interface SupabaseManagedInventoryAudit {
  readonly visibleProjects: number;
  readonly configuredOrganizationProjects: number;
  readonly managedResources: number;
  readonly excludedOtherOrganizationProjects: number;
  readonly excludedUnmanagedInConfiguredOrganization: number;
  readonly missingOrganizationAttribution: number;
}

/** Supabase Management API adapter with crash-safe project-name reconciliation. */
export class SupabaseDatabaseProvider implements DatabaseProvider {
  readonly name = "SUPABASE" as const;
  readonly #accessToken: string;
  readonly #organizationSlug: string;
  readonly #secretStore: SecretStore;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #migrationLeaseTtlMs: number;
  readonly #runtimeLeaseTtlMs: number;

  constructor(options: SupabaseDatabaseProviderOptions) {
    this.#accessToken = z.string().min(1).parse(options.accessToken);
    this.#organizationSlug = z
      .string()
      .trim()
      .min(1)
      .max(191)
      .parse(options.organizationSlug);
    this.#secretStore = options.secretStore;
    this.#baseUrl = new URL(options.baseUrl ?? "https://api.supabase.com")
      .toString()
      .replace(/\/$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#migrationLeaseTtlMs = options.migrationLeaseTtlMs ?? 15 * 60_000;
    this.#runtimeLeaseTtlMs = options.runtimeLeaseTtlMs ?? 60 * 60_000;
  }

  async provision(
    untrustedInput: DatabaseProvisionInput,
  ): Promise<DatabaseProvisionResult> {
    const input = ProvisionInputSchema.parse(untrustedInput);
    const providerName = deterministicProjectName(input);
    const existing = (await this.#listProjects()).find(
      (project) =>
        project.organization_slug === this.#organizationSlug &&
        project.name === providerName,
    );
    if (existing !== undefined) {
      return this.#recoverExisting(input, existing);
    }

    const operationReference = await this.#ensureOperationSecret(input.operationId);
    const password = await this.#secretStore.get(operationReference);
    const created = SupabaseProjectSchema.parse(
      await this.#request("POST", "/v1/projects", {
        name: providerName,
        organization_slug: this.#organizationSlug,
        db_pass: password,
        region_selection: { type: "smartGroup", code: input.region },
      }),
    );
    const externalId = projectReference(created);
    const connectionUri = createConnectionUri(externalId, password);
    const connectionSecretRef = await this.#secretStore.put(
      persistentSecretKey(externalId),
      connectionUri,
    );
    await this.#secretStore.revoke(operationReference);
    return toProvisionResult(created, input.region, connectionSecretRef, false);
  }

  async getHealth(externalId: string): Promise<DatabaseHealthStatus> {
    const projectRef = parseExternalId(externalId);
    const services = SupabaseHealthSchema.parse(
      await this.#request("GET", `/v1/projects/${encodeURIComponent(projectRef)}/health`),
    );
    const statuses = services.map((service) => service.status.toUpperCase());
    const state =
      statuses.length > 0 && statuses.every((status) => status === "ACTIVE_HEALTHY")
        ? "HEALTHY"
        : statuses.some((status) =>
              ["INACTIVE", "ERROR", "UNHEALTHY"].some((value) =>
                status.includes(value),
              ),
            )
          ? "UNHEALTHY"
          : "PROVISIONING";
    return {
      state,
      services: services.map((service) => ({
        name: service.name,
        status: service.status,
      })),
    };
  }

  async listManagedResources(): Promise<readonly ManagedDatabaseResource[]> {
    const projects = await this.#listProjects();
    return projects
      .filter(
        (project) =>
          project.organization_slug === this.#organizationSlug &&
          isManagedProjectName(project.name),
      )
      .map((project) => ({
        externalId: projectReference(project),
        name: project.name,
        region: project.region ?? null,
        status: project.status ?? null,
        createdAt: project.created_at ?? null,
      }));
  }

  /** Count-only staging evidence for tenant and naming-scope controls. */
  async auditManagedInventoryScope(): Promise<SupabaseManagedInventoryAudit> {
    const projects = await this.#listProjects();
    return {
      visibleProjects: projects.length,
      configuredOrganizationProjects: projects.filter(
        (project) => project.organization_slug === this.#organizationSlug,
      ).length,
      managedResources: projects.filter(
        (project) =>
          project.organization_slug === this.#organizationSlug &&
          isManagedProjectName(project.name),
      ).length,
      excludedOtherOrganizationProjects: projects.filter(
        (project) =>
          project.organization_slug !== undefined &&
          project.organization_slug !== this.#organizationSlug,
      ).length,
      excludedUnmanagedInConfiguredOrganization: projects.filter(
        (project) =>
          project.organization_slug === this.#organizationSlug &&
          !isManagedProjectName(project.name),
      ).length,
      missingOrganizationAttribution: projects.filter(
        (project) => project.organization_slug === undefined,
      ).length,
    };
  }

  getEphemeralConnection(
    externalId: string,
    scope: DatabaseConnectionScope,
    connectionSecretRef: string,
  ): Promise<SecretLease> {
    parseExternalId(externalId);
    return this.#secretStore.createLease(
      connectionSecretRef,
      scope,
      scope === "migrate"
        ? this.#migrationLeaseTtlMs
        : this.#runtimeLeaseTtlMs,
    );
  }

  async destroy(
    externalId: string,
    connectionSecretRef?: string,
  ): Promise<void> {
    const projectRef = parseExternalId(externalId);
    await this.#request(
      "DELETE",
      `/v1/projects/${encodeURIComponent(projectRef)}`,
      undefined,
      true,
    );
    if (connectionSecretRef !== undefined) {
      await this.#secretStore.revoke(connectionSecretRef);
    }
  }

  async #recoverExisting(
    input: z.infer<typeof ProvisionInputSchema>,
    project: z.infer<typeof SupabaseProjectSchema>,
  ): Promise<DatabaseProvisionResult> {
    const externalId = projectReference(project);
    const persistentKey = persistentSecretKey(externalId);
    let persistentReference: string | undefined;

    // A deterministic put returns the same logical reference for Vault and the
    // local test store, but we must not overwrite an existing password.
    const operationKey = operationSecretKey(input.operationId);
    const candidateReferences = [this.#secretStore.referenceForKey(persistentKey)];
    for (const candidate of candidateReferences) {
      try {
        await this.#secretStore.get(candidate);
        persistentReference = candidate;
        break;
      } catch (error) {
        if (!(error instanceof SecretStoreError) || error.code !== "SECRET_NOT_FOUND") {
          if (
            error instanceof SecretStoreError &&
            error.code === "INVALID_SECRET_REFERENCE"
          ) {
            continue;
          }
          throw error;
        }
      }
    }
    if (persistentReference !== undefined) {
      return toProvisionResult(project, input.region, persistentReference, true);
    }

    const operationReferences = [this.#secretStore.referenceForKey(operationKey)];
    for (const operationReference of operationReferences) {
      try {
        const password = await this.#secretStore.get(operationReference);
        const connectionSecretRef = await this.#secretStore.put(
          persistentKey,
          createConnectionUri(externalId, password),
        );
        await this.#secretStore.revoke(operationReference);
        return toProvisionResult(
          project,
          input.region,
          connectionSecretRef,
          true,
        );
      } catch (error) {
        if (
          error instanceof SecretStoreError &&
          ["SECRET_NOT_FOUND", "INVALID_SECRET_REFERENCE"].includes(error.code)
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new DatabaseProviderError(
      "Existing Supabase project cannot be reconciled because its database secret is missing",
      { code: "ORPHANED_DATABASE_SECRET", retryable: false },
    );
  }

  async #ensureOperationSecret(operationId: string): Promise<string> {
    const key = operationSecretKey(operationId);
    const knownReferences = [this.#secretStore.referenceForKey(key)];
    for (const reference of knownReferences) {
      try {
        await this.#secretStore.get(reference);
        return reference;
      } catch (error) {
        if (
          error instanceof SecretStoreError &&
          ["SECRET_NOT_FOUND", "INVALID_SECRET_REFERENCE"].includes(error.code)
        ) {
          continue;
        }
        throw error;
      }
    }
    return this.#secretStore.put(key, createDatabasePassword());
  }

  async #listProjects(): Promise<ReadonlyArray<z.infer<typeof SupabaseProjectSchema>>> {
    return SupabaseProjectsSchema.parse(await this.#request("GET", "/v1/projects"));
  }

  async #request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    ignoreNotFound = false,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#accessToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new DatabaseProviderError("Supabase Management API request failed", {
        code: "SUPABASE_UNAVAILABLE",
        retryable: true,
        cause: error,
      });
    }
    if (ignoreNotFound && response.status === 404) return {};
    if (!response.ok) {
      throw new DatabaseProviderError(
        `Supabase Management API returned HTTP ${String(response.status)}`,
        {
          code:
            response.status === 401 || response.status === 403
              ? "SUPABASE_AUTHORIZATION_FAILED"
              : response.status === 429
                ? "SUPABASE_RATE_LIMITED"
                : "SUPABASE_REQUEST_FAILED",
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        },
      );
    }
    if (response.status === 204) return {};
    return response.json();
  }
}

function deterministicProjectName(input: z.infer<typeof ProvisionInputSchema>): string {
  const base = input.displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return `atoms-${base || "project"}-${input.operationId.replaceAll("-", "").slice(0, 12)}`;
}

function isManagedProjectName(value: string): boolean {
  return /^atoms-[a-z0-9](?:[a-z0-9-]{0,26}[a-z0-9])?-[a-f0-9]{12}$/.test(
    value,
  );
}

function createDatabasePassword(): string {
  return `${randomBytes(30).toString("base64url")}Aa1!`;
}

function operationSecretKey(operationId: string): string {
  return `database-provisioning/${operationId}/password`;
}

function persistentSecretKey(externalId: string): string {
  return `databases/supabase/${externalId}/connection`;
}

function projectReference(project: z.infer<typeof SupabaseProjectSchema>): string {
  return parseExternalId(project.ref ?? project.id ?? "");
}

function parseExternalId(value: string): string {
  return z.string().trim().min(1).max(191).regex(/^[a-zA-Z0-9_-]+$/).parse(value);
}

function createConnectionUri(externalId: string, password: string): string {
  return `postgresql://postgres:${encodeURIComponent(password)}@db.${externalId}.supabase.co:5432/postgres?sslmode=require`;
}

function toProvisionResult(
  project: z.infer<typeof SupabaseProjectSchema>,
  requestedRegion: string,
  connectionSecretRef: string,
  reconciled: boolean,
): DatabaseProvisionResult {
  const externalId = projectReference(project);
  return {
    externalId,
    databaseName: "postgres",
    region: project.region ?? requestedRegion,
    connectionSecretRef,
    providerOperationMetadata: {
      reconciled: String(reconciled),
      ...(project.status === undefined ? {} : { initialStatus: project.status }),
    },
  };
}

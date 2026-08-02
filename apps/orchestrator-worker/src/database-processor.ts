import {
  DatabaseOperationJobSchema,
  type DatabaseOperationJob,
  type JsonValue,
} from "@atoms/contracts";
import {
  DatabaseMigrationError,
  DatabaseProviderError,
  SecretStoreError,
  type DatabaseMigrationRunner,
  type DatabaseProvider,
  type SecretStore,
} from "@atoms/database-provider";

import type { DatabaseOperationRepository } from "./database-domain.js";

export type DatabaseProcessResult =
  | { readonly outcome: "completed" }
  | { readonly outcome: "failed" }
  | { readonly outcome: "skipped"; readonly reason: "missing" | "stale" };

export interface DatabaseOperationProcessorOptions {
  readonly repository: DatabaseOperationRepository;
  readonly provider: DatabaseProvider;
  readonly secretStore: SecretStore;
  readonly migrationRunner: DatabaseMigrationRunner;
  readonly healthAttempts?: number;
  readonly healthIntervalMs?: number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
}

export class DatabaseOperationProcessor {
  readonly #repository: DatabaseOperationRepository;
  readonly #provider: DatabaseProvider;
  readonly #secretStore: SecretStore;
  readonly #migrationRunner: DatabaseMigrationRunner;
  readonly #healthAttempts: number;
  readonly #healthIntervalMs: number;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #now: () => Date;

  constructor(options: DatabaseOperationProcessorOptions) {
    this.#repository = options.repository;
    this.#provider = options.provider;
    this.#secretStore = options.secretStore;
    this.#migrationRunner = options.migrationRunner;
    this.#healthAttempts = options.healthAttempts ?? 30;
    this.#healthIntervalMs = options.healthIntervalMs ?? 2_000;
    this.#delay = options.delay ?? delay;
    this.#now = options.now ?? (() => new Date());
  }

  async process(
    untrustedJob: DatabaseOperationJob,
    attempt: { readonly attempt: number; readonly maxAttempts: number },
  ): Promise<DatabaseProcessResult> {
    const job = DatabaseOperationJobSchema.parse(untrustedJob);
    const claim = await this.#repository.claim(job, this.#now());
    if (claim.kind === "missing") return { outcome: "skipped", reason: "missing" };
    if (claim.kind === "stale") return { outcome: "skipped", reason: "stale" };
    const database = claim.database;

    try {
      if (job.command === "destroy") {
        if (database.externalId !== null) {
          await this.#provider.destroy(
            database.externalId,
            database.connectionSecretRef ?? undefined,
          );
        }
        if (!(await this.#repository.completeDestroy(database, this.#now()))) {
          return { outcome: "skipped", reason: "stale" };
        }
        return { outcome: "completed" };
      }

      const provisioned = await this.#provider.provision({
        operationId: database.operationId,
        projectId: database.projectId,
        displayName: database.displayName,
        region: database.region,
      });
      if (
        !(await this.#repository.recordProvisioned(
          database,
          provisioned,
          this.#now(),
        ))
      ) {
        return { outcome: "skipped", reason: "stale" };
      }
      const activeDatabase = {
        ...database,
        externalId: provisioned.externalId,
        connectionSecretRef: provisioned.connectionSecretRef,
        status: "HEALTH_CHECK" as const,
      };

      let healthy = false;
      for (let index = 0; index < this.#healthAttempts; index += 1) {
        const health = await this.#provider.getHealth(provisioned.externalId);
        if (
          !(await this.#repository.recordHealthCheck(
            activeDatabase,
            `Health poll ${String(index + 1)}: ${health.state}`,
            this.#now(),
          ))
        ) {
          return { outcome: "skipped", reason: "stale" };
        }
        if (health.state === "UNHEALTHY") {
          throw new DatabaseProviderError("Supabase services reported unhealthy", {
            code: "DATABASE_UNHEALTHY",
            retryable: true,
          });
        }
        if (health.state === "HEALTHY") {
          healthy = true;
          break;
        }
        if (index + 1 < this.#healthAttempts) {
          await this.#delay(this.#healthIntervalMs);
        }
      }
      if (!healthy) {
        throw new DatabaseProviderError("Timed out waiting for Supabase health", {
          code: "DATABASE_HEALTH_TIMEOUT",
          retryable: true,
        });
      }

      if (!(await this.#repository.startMigration(activeDatabase, this.#now()))) {
        return { outcome: "skipped", reason: "stale" };
      }
      const lease = await this.#provider.getEphemeralConnection(
        provisioned.externalId,
        "migrate",
        provisioned.connectionSecretRef,
      );
      try {
        const connectionUrl = await this.#secretStore.get(lease.reference);
        const files = await this.#repository.listProjectFiles(database.projectId);
        const result = await this.#migrationRunner.migrate({
          files: files.map((file) => ({ path: file.path, content: file.content })),
          connectionUrl,
          metadata: {
            workspaceId: database.workspaceId,
            projectId: database.projectId,
            databaseInstanceId: database.id,
            operationId: database.operationId,
          },
        });
        if (
          !(await this.#repository.completeMigration(
            activeDatabase,
            result.steps,
            this.#now(),
          ))
        ) {
          return { outcome: "skipped", reason: "stale" };
        }
      } finally {
        await this.#secretStore.revoke(lease.reference).catch(() => undefined);
      }
      return { outcome: "completed" };
    } catch (error) {
      await this.#repository.fail(database, toDatabaseError(error), this.#now());
      if (isRetryable(error) && attempt.attempt < attempt.maxAttempts) {
        throw error;
      }
      return { outcome: "failed" };
    }
  }
}

function isRetryable(error: unknown): boolean {
  return (
    (error instanceof DatabaseProviderError || error instanceof SecretStoreError) &&
    error.retryable
  );
}

function toDatabaseError(error: unknown): JsonValue {
  if (error instanceof DatabaseProviderError || error instanceof SecretStoreError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof DatabaseMigrationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
      step: error.step,
      exitCode: error.exitCode,
    };
  }
  return {
    code: "DATABASE_OPERATION_FAILED",
    message: error instanceof Error ? error.message : "Unknown database operation failure",
    retryable: false,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

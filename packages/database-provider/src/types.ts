export type DatabaseConnectionScope = "migrate" | "runtime";

export interface SecretLease {
  readonly reference: string;
  readonly expiresAt: string;
}

export interface SecretStore {
  referenceForKey(key: string): string;
  put(
    key: string,
    value: string,
    options?: { readonly expiresAt?: string },
  ): Promise<string>;
  get(reference: string): Promise<string>;
  createLease(
    sourceReference: string,
    scope: DatabaseConnectionScope,
    ttlMs: number,
  ): Promise<SecretLease>;
  revoke(reference: string): Promise<void>;
}

export interface DatabaseProvisionInput {
  readonly operationId: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly region: string;
}

export interface DatabaseProvisionResult {
  readonly externalId: string;
  readonly databaseName: string;
  readonly region: string;
  readonly connectionSecretRef: string;
  readonly providerOperationMetadata: Readonly<Record<string, string>>;
}

export type DatabaseHealthState = "PROVISIONING" | "HEALTHY" | "UNHEALTHY";

export interface DatabaseHealthStatus {
  readonly state: DatabaseHealthState;
  readonly services: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
  }>;
}

export interface ManagedDatabaseResource {
  readonly externalId: string;
  readonly name: string;
  readonly region: string | null;
  readonly status: string | null;
  readonly createdAt: string | null;
}

export interface DatabaseProvider {
  readonly name: "SUPABASE";
  provision(input: DatabaseProvisionInput): Promise<DatabaseProvisionResult>;
  listManagedResources(): Promise<readonly ManagedDatabaseResource[]>;
  getHealth(externalId: string): Promise<DatabaseHealthStatus>;
  getEphemeralConnection(
    externalId: string,
    scope: DatabaseConnectionScope,
    connectionSecretRef: string,
  ): Promise<SecretLease>;
  destroy(externalId: string, connectionSecretRef?: string): Promise<void>;
}

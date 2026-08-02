import { createHash, randomUUID } from "node:crypto";

import {
  PHASE3_PROVIDER_STAGING_EVIDENCE_VERSION,
  PHASE3_VARIABLE_COST_TARGET_CAD_MICROS,
  Phase3ProviderStagingEvidenceSchema,
  Phase3StagingGateNameSchema,
  type Phase3ProviderStagingEvidence,
  type Phase3StagingGateEvidence,
  type Phase3StagingGateName,
  type JsonValue,
} from "@atoms/contracts";
import { z } from "zod";

import type { DatabaseMigrationRunner, DatabaseMigrationStepReport } from "./migration-runner.js";
import type { DatabaseProvider, SecretStore } from "./types.js";

const ScenarioInputSchema = z
  .object({
    scenarioId: z.string().uuid(),
    projectId: z.string().uuid(),
    changeTicket: z
      .string()
      .trim()
      .min(1)
      .max(191)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
    measuredVariableCostCadMicros: z.number().int().nonnegative(),
    region: z.enum(["americas", "emea", "apac"]),
    fixtureFiles: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(1_024),
            content: z.string().max(5_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
  })
  .strict();

const initialGateDetails = { reason: "not_run" } as const;

export interface Phase3ProviderStagingScenarioOptions {
  readonly provider: DatabaseProvider;
  readonly secretStore: SecretStore;
  readonly migrationRunner: DatabaseMigrationRunner;
  readonly fixtureFiles: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly changeTicket: string;
  readonly measuredVariableCostCadMicros: number;
  readonly region?: "americas" | "emea" | "apac";
  readonly scenarioId?: string;
  readonly projectId?: string;
  readonly healthTimeoutMs?: number;
  readonly healthPollIntervalMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (durationMs: number) => Promise<void>;
  readonly cleanupOwnedResource?: (input: {
    readonly externalId: string;
    readonly connectionSecretRef: string;
  }) => Promise<JsonValue | void>;
  readonly inventoryEvidence?: JsonValue;
}

/**
 * Runs the deliberately billable Phase 3 provider proof and returns only
 * credential-free, machine-validated evidence. The caller owns opt-in and
 * operator approval; this function always attempts cleanup for resources it
 * can prove were created by this scenario.
 */
export async function runPhase3ProviderStagingScenario(
  options: Phase3ProviderStagingScenarioOptions,
): Promise<Phase3ProviderStagingEvidence> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  }));
  const healthTimeoutMs = z.number().int().min(5_000).max(15 * 60_000).parse(
    options.healthTimeoutMs ?? 5 * 60_000,
  );
  const healthPollIntervalMs = z.number().int().min(250).max(30_000).parse(
    options.healthPollIntervalMs ?? 5_000,
  );
  const input = ScenarioInputSchema.parse({
    scenarioId: options.scenarioId ?? randomUUID(),
    projectId: options.projectId ?? randomUUID(),
    changeTicket: options.changeTicket,
    measuredVariableCostCadMicros: options.measuredVariableCostCadMicros,
    region: options.region ?? "americas",
    fixtureFiles: options.fixtureFiles,
  });
  const startedAt = now();
  const gates = new Map<Phase3StagingGateName, Phase3StagingGateEvidence>(
    Phase3StagingGateNameSchema.options.map((name) => [
      name,
      { name, status: "FAILED", durationMs: 0, details: initialGateDetails },
    ]),
  );
  const errors: Array<{ readonly code: string; readonly message: string }> = [];
  let managedResourcesBefore = 0;
  let managedResourcesAfter = 0;
  let createdResources = 0;
  let deletedResources = 0;
  let externalId: string | undefined;
  let externalResourceFingerprint: string | null = null;
  let connectionSecretRef: string | undefined;
  let leaseReference: string | undefined;
  let ownedByScenario = false;
  let inventoryBeforeCompleted = false;
  let scenarioFailed = false;
  const migrationSteps: DatabaseMigrationStepReport[] = [];
  const resourcesBefore = new Set<string>();

  const setGate = (
    name: Phase3StagingGateName,
    status: "PASSED" | "FAILED",
    gateStartedAt: Date,
    details: Phase3StagingGateEvidence["details"],
  ): void => {
    gates.set(name, {
      name,
      status,
      durationMs: Math.max(0, now().getTime() - gateStartedAt.getTime()),
      details,
    });
  };

  const costStartedAt = now();
  const costWithinTarget =
    input.measuredVariableCostCadMicros <=
    PHASE3_VARIABLE_COST_TARGET_CAD_MICROS;
  setGate(
    "variable_cost",
    costWithinTarget ? "PASSED" : "FAILED",
    costStartedAt,
    {
      measuredCadMicros: input.measuredVariableCostCadMicros,
      targetCadMicros: PHASE3_VARIABLE_COST_TARGET_CAD_MICROS,
    },
  );

  try {
    if (!costWithinTarget) {
      throw stagingError(
        "VARIABLE_COST_TARGET_EXCEEDED",
        "Measured variable cost exceeds the approved Phase 3 target",
      );
    }

    const inventoryStartedAt = now();
    const before = await options.provider.listManagedResources();
    managedResourcesBefore = before.length;
    for (const resource of before) resourcesBefore.add(resource.externalId);
    inventoryBeforeCompleted = true;
    setGate("provider_inventory_before", "PASSED", inventoryStartedAt, {
      managedResourceCount: managedResourcesBefore,
      ...(options.inventoryEvidence === undefined
        ? {}
        : { scopeAudit: options.inventoryEvidence }),
    });

    const provisionStartedAt = now();
    const provisioned = await options.provider.provision({
      operationId: input.scenarioId,
      projectId: input.projectId,
      displayName: "Atoms Phase 3 staging",
      region: input.region,
    });
    externalId = provisioned.externalId;
    connectionSecretRef = provisioned.connectionSecretRef;
    externalResourceFingerprint = createHash("sha256")
      .update(externalId)
      .digest("hex");
    ownedByScenario = !resourcesBefore.has(externalId);
    if (!ownedByScenario) {
      setGate("provider_provision", "FAILED", provisionStartedAt, {
        provider: options.provider.name,
        reason: "resource_preexisted",
      });
      throw stagingError(
        "STAGING_RESOURCE_PREEXISTED",
        "The deterministic provider resource existed before this scenario",
      );
    }
    createdResources = 1;
    setGate("provider_provision", "PASSED", provisionStartedAt, {
      provider: options.provider.name,
      region: provisioned.region,
      reconciled: provisioned.providerOperationMetadata.reconciled ?? "false",
    });

    const healthStartedAt = now();
    const healthDeadline = now().getTime() + healthTimeoutMs;
    let healthAttempts = 0;
    while (true) {
      healthAttempts += 1;
      const health = await options.provider.getHealth(externalId);
      if (health.state === "HEALTHY") {
        setGate("provider_health", "PASSED", healthStartedAt, {
          attempts: healthAttempts,
          state: health.state,
        });
        break;
      }
      if (health.state === "UNHEALTHY" || now().getTime() >= healthDeadline) {
        setGate("provider_health", "FAILED", healthStartedAt, {
          attempts: healthAttempts,
          state: health.state,
        });
        throw stagingError(
          "PROVIDER_HEALTH_TIMEOUT",
          "The staging database did not reach a healthy state",
        );
      }
      await sleep(healthPollIntervalMs);
    }

    const lease = await options.provider.getEphemeralConnection(
      externalId,
      "migrate",
      connectionSecretRef,
    );
    leaseReference = lease.reference;
    const connectionUrl = await options.secretStore.get(lease.reference);
    await options.migrationRunner.migrate({
      files: input.fixtureFiles,
      connectionUrl,
      metadata: {
        scenarioId: input.scenarioId,
        changeTicket: input.changeTicket,
      },
      onStep: async (step) => {
        migrationSteps.push(step);
        setMigrationGate(gates, step);
      },
    });
    for (const stepName of [
      "install",
      "migrate",
      "seed",
      "connectivity",
    ] as const) {
      if (!migrationSteps.some((step) => step.name === stepName)) {
        throw stagingError(
          "MIGRATION_STEP_MISSING",
          `The E2B migration report omitted ${stepName}`,
        );
      }
    }
  } catch (error) {
    scenarioFailed = true;
    errors.push(toSafeStagingError(error));
  } finally {
    if (leaseReference !== undefined) {
      await options.secretStore.revoke(leaseReference).catch((error: unknown) => {
        scenarioFailed = true;
        errors.push(
          toSafeStagingError(
            stagingError(
              "LEASE_REVOCATION_FAILED",
              error instanceof Error
                ? error.message
                : "The staging database lease could not be revoked",
            ),
          ),
        );
      });
    }

    const cleanupStartedAt = now();
    if (
      ownedByScenario &&
      externalId !== undefined &&
      connectionSecretRef !== undefined
    ) {
      try {
        const cleanupDetails =
          options.cleanupOwnedResource === undefined
            ? (await options.provider.destroy(externalId, connectionSecretRef),
              { strategy: "direct_confirmed_teardown" })
            : await options.cleanupOwnedResource({
                externalId,
                connectionSecretRef,
              });
        deletedResources = 1;
        setGate("provider_cleanup", "PASSED", cleanupStartedAt, {
          destroyedOwnedResource: true,
          ...(cleanupDetails === undefined
            ? { strategy: "custom_approved_cleanup" }
            : { cleanup: cleanupDetails }),
        });
      } catch (error) {
        scenarioFailed = true;
        let fallbackDestroyed = false;
        try {
          await options.provider.destroy(externalId, connectionSecretRef);
          deletedResources = 1;
          fallbackDestroyed = true;
        } catch {
          // The failed inventory-restoration gate below preserves the cleanup
          // incident without copying provider diagnostics or secrets.
        }
        setGate("provider_cleanup", "FAILED", cleanupStartedAt, {
          destroyedOwnedResource: fallbackDestroyed,
          emergencyFallbackAttempted: true,
        });
        errors.push(
          toSafeStagingError(
            stagingError(
              "PROVIDER_CLEANUP_FAILED",
              error instanceof Error
                ? error.message
                : "The owned staging resource could not be deleted",
            ),
          ),
        );
      }
    } else {
      setGate("provider_cleanup", "FAILED", cleanupStartedAt, {
        destroyedOwnedResource: false,
        reason: "no_owned_resource",
      });
    }

    const inventoryAfterStartedAt = now();
    if (!inventoryBeforeCompleted) {
      setGate("provider_inventory_after", "FAILED", inventoryAfterStartedAt, {
        reason: "baseline_inventory_not_recorded",
      });
    } else try {
      const after = await options.provider.listManagedResources();
      managedResourcesAfter = after.length;
      const ownedResourceStillPresent =
        externalId !== undefined &&
        after.some((resource) => resource.externalId === externalId);
      const inventoryRestored =
        !ownedResourceStillPresent &&
        managedResourcesAfter === managedResourcesBefore;
      if (!inventoryRestored) scenarioFailed = true;
      setGate(
        "provider_inventory_after",
        inventoryRestored ? "PASSED" : "FAILED",
        inventoryAfterStartedAt,
        {
          managedResourceCount: managedResourcesAfter,
          baselineRestored: inventoryRestored,
        },
      );
      if (!inventoryRestored) {
        errors.push({
          code: "PROVIDER_INVENTORY_NOT_RESTORED",
          message: "Provider inventory did not return to its pre-scenario baseline",
        });
      }
    } catch (error) {
      scenarioFailed = true;
      setGate("provider_inventory_after", "FAILED", inventoryAfterStartedAt, {
        reason: "inventory_unavailable",
      });
      errors.push(
        toSafeStagingError(
          stagingError(
            "FINAL_INVENTORY_FAILED",
            error instanceof Error
              ? error.message
              : "Final provider inventory failed",
          ),
        ),
      );
    }
  }

  const orderedGates = Phase3StagingGateNameSchema.options.map((name) => {
    const gate = gates.get(name);
    if (gate === undefined) throw new Error(`Missing staging gate ${name}`);
    return gate;
  });
  const result =
    !scenarioFailed && orderedGates.every((gate) => gate.status === "PASSED")
      ? "PASSED"
      : "FAILED";
  return Phase3ProviderStagingEvidenceSchema.parse({
    version: PHASE3_PROVIDER_STAGING_EVIDENCE_VERSION,
    scenarioId: input.scenarioId,
    changeTicket: input.changeTicket,
    environment: "staging",
    result,
    startedAt: startedAt.toISOString(),
    completedAt: now().toISOString(),
    externalResourceFingerprint,
    managedResourcesBefore,
    managedResourcesAfter,
    createdResources,
    deletedResources,
    measuredVariableCostCadMicros: input.measuredVariableCostCadMicros,
    variableCostTargetCadMicros: PHASE3_VARIABLE_COST_TARGET_CAD_MICROS,
    gates: orderedGates,
    errors: deduplicateErrors(errors),
  });
}

function setMigrationGate(
  gates: Map<Phase3StagingGateName, Phase3StagingGateEvidence>,
  step: DatabaseMigrationStepReport,
): void {
  const gateName = {
    install: "e2b_install",
    migrate: "database_migrate",
    seed: "database_seed",
    connectivity: "database_connectivity",
  }[step.name] as Phase3StagingGateName;
  gates.set(gateName, {
    name: gateName,
    status: step.result.exitCode === 0 ? "PASSED" : "FAILED",
    durationMs: step.result.durationMs,
    details: { exitCode: step.result.exitCode },
  });
}

function stagingError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function toSafeStagingError(error: unknown): {
  readonly code: string;
  readonly message: string;
} {
  const rawCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "PHASE3_STAGING_SCENARIO_FAILED";
  const code = /^[A-Z][A-Z0-9_]{2,99}$/.test(rawCode)
    ? rawCode
    : "PHASE3_STAGING_SCENARIO_FAILED";
  const rawMessage =
    error instanceof Error ? error.message : "The Phase 3 staging scenario failed";
  return {
    code,
    message: redactEvidenceText(rawMessage).slice(0, 1_000),
  };
}

function redactEvidenceText(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/giu, "[REDACTED_DATABASE_URL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [REDACTED]");
}

function deduplicateErrors(
  errors: ReadonlyArray<{ readonly code: string; readonly message: string }>,
): ReadonlyArray<{ readonly code: string; readonly message: string }> {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const fingerprint = `${error.code}\u0000${error.message}`;
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

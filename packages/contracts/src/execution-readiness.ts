import { z } from "zod";

const IsoTimestampSchema = z.string().datetime({ offset: true });

/**
 * What the worker knows about itself and publishes for the Control API, which
 * cannot see the worker's environment (docs/adr/production-execution-gate.md, G7).
 * Booleans only: no secret and no configuration value leaves the worker.
 */
export const WorkerReadinessReportSchema = z
  .object({
    version: z.literal(1),
    publishedAt: IsoTimestampSchema,
    /** RUN_PROVIDER_BUDGET_USD_MICROS > 0 (G1, lock 2). */
    runBudgetConfigured: z.boolean(),
    /** WORKSPACE_PROVIDER_BUDGET_USD_MICROS_PER_DAY > 0 (G1). */
    workspaceCeilingConfigured: z.boolean(),
    /** Provider credentials are present (lock 3). Presence only, not validity. */
    providerCredentialsPresent: z.boolean(),
    /** An operator recorded a passing live egress probe (G5), see SANDBOX_EGRESS_VERIFIED_AT. */
    egressVerified: z.boolean(),
    /** Only Sophia and Emma accept references, and both carry the contract (G4). */
    attachmentContractVerified: z.boolean(),
    /** The validation step loads the preview in a real browser (PREVIEW_BROWSER_VIABILITY=required, G7). */
    browserViabilityRequired: z.boolean(),
  })
  .strict();

export type WorkerReadinessReport = z.infer<typeof WorkerReadinessReportSchema>;

export const EXECUTION_GATE_IDS = ["G1", "G4", "G5", "G7", "LOCK_3"] as const;
export type ExecutionGateId = (typeof EXECUTION_GATE_IDS)[number];

export const EXECUTION_GATE_NAMES: Readonly<Record<ExecutionGateId, string>> = {
  G1: "Cost boundary: per-run budget and per-workspace daily ceiling configured on the worker",
  G4: "Attachment trust boundary: reference contract intact",
  G5: "Network egress: live probe recorded",
  G7: "Preview viability: every validated preview is loaded in a real browser",
  LOCK_3: "Provider credentials present on the worker",
};

/** The worker report is considered stale after this long without a heartbeat. */
export const WORKER_READINESS_MAX_AGE_MS = 90_000;

export const ExecutionReadinessSchema = z
  .object({
    /** The Control API is healthy. Independent of whether AI execution is on. */
    platformReady: z.literal(true),
    /** Lock 1: RUN_EXECUTION_ENABLED. */
    controlPlaneEnabled: z.boolean(),
    /** Every worker-side precondition holds, whatever the flag says. */
    preconditionsMet: z.boolean(),
    /** Flag on and all preconditions met: the READY_FOR_LIVE_EXECUTION state. */
    executionReady: z.boolean(),
    /** Flag on while a precondition fails: the locks disagree. */
    inconsistent: z.boolean(),
    failingGates: z.array(z.enum(EXECUTION_GATE_IDS)),
    /** Whether the worker's own state is known. */
    workerState: z.enum(["reporting", "missing", "stale"]),
  })
  .strict();

export type ExecutionReadiness = z.infer<typeof ExecutionReadinessSchema>;

export function evaluateExecutionReadiness(input: {
  readonly controlPlaneEnabled: boolean;
  readonly worker: WorkerReadinessReport | null;
  readonly now: Date;
}): ExecutionReadiness {
  const { worker } = input;
  const ageMs =
    worker === null
      ? Number.POSITIVE_INFINITY
      : input.now.getTime() - Date.parse(worker.publishedAt);
  const workerState: ExecutionReadiness["workerState"] =
    worker === null
      ? "missing"
      : // A timestamp from the future is not trusted either.
        Math.abs(ageMs) > WORKER_READINESS_MAX_AGE_MS
        ? "stale"
        : "reporting";
  const fresh = workerState === "reporting" ? worker : null;

  // Without a fresh report every worker-side gate is unknown, and unknown fails.
  const passes: Record<ExecutionGateId, boolean> = {
    G1: fresh !== null && fresh.runBudgetConfigured && fresh.workspaceCeilingConfigured,
    G4: fresh?.attachmentContractVerified === true,
    G5: fresh?.egressVerified === true,
    G7: fresh?.browserViabilityRequired === true,
    LOCK_3: fresh?.providerCredentialsPresent === true,
  };
  const failingGates = EXECUTION_GATE_IDS.filter((id) => !passes[id]);
  const preconditionsMet = failingGates.length === 0;

  return {
    platformReady: true,
    controlPlaneEnabled: input.controlPlaneEnabled,
    preconditionsMet,
    executionReady: input.controlPlaneEnabled && preconditionsMet,
    inconsistent: input.controlPlaneEnabled && !preconditionsMet,
    failingGates,
    workerState,
  };
}

export const WORKER_READINESS_KEY_SUFFIX = "readiness:worker";

/** Redis key the worker publishes to and the Control API reads from. */
export function workerReadinessKey(prefix?: string): string {
  return `${prefix ?? "atoms"}:${WORKER_READINESS_KEY_SUFFIX}`;
}

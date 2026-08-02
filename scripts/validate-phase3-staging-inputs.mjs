const workflowConfirmation = process.env.PHASE3_WORKFLOW_CONFIRMATION;
const liveProviderRequested = process.env.PHASE3_RUN_LIVE_PROVIDER === "true";
const changeTicket = process.env.PHASE3_STAGING_CHANGE_TICKET ?? "";
const measuredCostCad = process.env.PHASE3_STAGING_MEASURED_COST_CAD ?? "";
const destructiveConfirmation =
  process.env.PHASE3_STAGING_DESTRUCTIVE_CONFIRMATION;

if (workflowConfirmation !== "RUN_PHASE3_STAGING") {
  throw new Error("Workflow confirmation must exactly equal RUN_PHASE3_STAGING");
}
if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/.test(changeTicket)) {
  throw new Error("A normalized staging change-ticket identifier is required");
}
if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(measuredCostCad)) {
  throw new Error("Measured variable cost must be a non-negative CAD amount with at most six decimals");
}

const [whole = "0", fractional = ""] = measuredCostCad.split(".");
const measuredMicros =
  BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, "0"));
if (liveProviderRequested) {
  if (
    destructiveConfirmation !==
    "PROVISION_MIGRATE_AND_DESTROY_SUPABASE_STAGING_DATABASE"
  ) {
    throw new Error("Live provider execution requires the exact destructive confirmation");
  }
  if (measuredMicros > 4_000_000n) {
    throw new Error("Measured variable cost exceeds the CAD 4 Phase 3 target");
  }
}

console.log(
  `Phase 3 staging preflight passed (${liveProviderRequested ? "full provider exit" : "migration and durability only"})`,
);

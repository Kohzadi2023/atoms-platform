import { SOLO_OPERATOR_CONFIRMATION } from "./verify-phase3-environment-protection.mjs";
import { parseApprovedBudget } from "./phase3-cost.mjs";

const workflowConfirmation = process.env.PHASE3_WORKFLOW_CONFIRMATION;
const liveProviderRequested = process.env.PHASE3_RUN_LIVE_PROVIDER === "true";
const changeTicket = process.env.PHASE3_STAGING_CHANGE_TICKET ?? "";
const approvedBudgetCad = process.env.PHASE3_STAGING_APPROVED_BUDGET_CAD;
const destructiveConfirmation =
  process.env.PHASE3_STAGING_DESTRUCTIVE_CONFIRMATION;
const soloOperatorConfirmation = process.env.PHASE3_SOLO_OPERATOR_CONFIRMATION;

if (workflowConfirmation !== "RUN_PHASE3_STAGING") {
  throw new Error("Workflow confirmation must exactly equal RUN_PHASE3_STAGING");
}
if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/.test(changeTicket)) {
  throw new Error("A normalized staging change-ticket identifier is required");
}
if (liveProviderRequested) {
  parseApprovedBudget(approvedBudgetCad);
  if (process.env.PHASE3_STAGING_MEASURED_COST_CAD) {
    throw new Error("Actual cost must be recorded after the run in the cost finalization workflow");
  }
  if (soloOperatorConfirmation !== SOLO_OPERATOR_CONFIRMATION) {
    throw new Error("Live provider execution requires the exact solo-operator confirmation");
  }
  if (
    destructiveConfirmation !==
    "PROVISION_MIGRATE_AND_DESTROY_SUPABASE_STAGING_DATABASE"
  ) {
    throw new Error("Live provider execution requires the exact destructive confirmation");
  }
}

console.log(
  `Phase 3 staging preflight passed (${liveProviderRequested ? "solo-operator provider exit" : "migration and durability only"})`,
);

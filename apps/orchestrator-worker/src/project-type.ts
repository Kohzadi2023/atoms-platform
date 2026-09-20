import type { ActiveAgentName } from "@atoms/agents";
import { agentsRequiredFor, type ProjectType } from "@atoms/contracts";

// The mapping itself lives in @atoms/contracts (PROJECT_TYPE_AGENTS) so the worker and the
// smoke test's capability matrix are checked against one definition.
export function isRequiredForProjectType(
  projectType: ProjectType,
  agentName: ActiveAgentName,
): boolean {
  return agentsRequiredFor(projectType).some((agent) => agent === agentName);
}

/** Why an agent's task was recorded as skipped instead of run. */
export type SkipReason = "NOT_REQUIRED_FOR_PROJECT_TYPE" | "PLAN_NOT_ENTITLED";

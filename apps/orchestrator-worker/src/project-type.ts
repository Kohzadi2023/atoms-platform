import type { ActiveAgentName } from "@atoms/agents";
import type { ProjectType } from "@atoms/contracts";

/**
 * Which agents a run needs for each project type. GENERAL is every agent the run graph
 * has, which is what every project needed before types existed. CLIENT_PORTAL is the Q1
 * template: an operational tool, so no market research (Sophia), SEO (Sarah) or growth
 * copy (Adrian). See docs/client-portal-reference-architecture.md.
 *
 * Declared as a Record so adding a ProjectType without deciding its agents will not compile.
 */
export const PROJECT_TYPE_AGENTS: Readonly<
  Record<ProjectType, ReadonlySet<ActiveAgentName>>
> = {
  GENERAL: new Set<ActiveAgentName>([
    "Sophia",
    "Mike",
    "Emma",
    "Bob",
    "Alex",
    "David",
    "Sarah",
    "Adrian",
  ]),
  CLIENT_PORTAL: new Set<ActiveAgentName>(["Mike", "Emma", "Bob", "Alex", "David"]),
};

export function isRequiredForProjectType(
  projectType: ProjectType,
  agentName: ActiveAgentName,
): boolean {
  return PROJECT_TYPE_AGENTS[projectType].has(agentName);
}

/** Why an agent's task was recorded as skipped instead of run. */
export type SkipReason = "NOT_REQUIRED_FOR_PROJECT_TYPE" | "PLAN_NOT_ENTITLED";

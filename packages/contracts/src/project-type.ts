import type { ProjectType } from "./api.js";
import type { RunAgentName } from "./events.js";

/**
 * Which agents a run needs for each project type, in run order. This is the single
 * source of truth: the worker routes on it and the authenticated smoke test asserts
 * against it, so an agent count is never hardcoded in either.
 *
 * GENERAL is every agent the run graph has, which is what every project needed before
 * types existed. CLIENT_PORTAL is the Q1 template, an operational tool, so no market
 * research (Sophia), SEO (Sarah) or growth copy (Adrian); see
 * docs/client-portal-reference-architecture.md.
 *
 * Declared as a Record so adding a ProjectType without deciding its agents does not compile.
 */
export const PROJECT_TYPE_AGENTS: Readonly<
  Record<ProjectType, readonly RunAgentName[]>
> = {
  GENERAL: ["Sophia", "Mike", "Emma", "Bob", "Alex", "David", "Sarah", "Adrian"],
  CLIENT_PORTAL: ["Mike", "Emma", "Bob", "Alex", "David"],
};

export function agentsRequiredFor(projectType: ProjectType): readonly RunAgentName[] {
  return PROJECT_TYPE_AGENTS[projectType];
}

/**
 * The approvals a run stops for when references are attached: the plan approval, and
 * the content approval only if a content agent (Adrian) is part of the run.
 */
export function expectedApprovalScopes(projectType: ProjectType): readonly ("plan" | "content")[] {
  return agentsRequiredFor(projectType).includes("Adrian")
    ? ["plan", "content"]
    : ["plan"];
}

import type { ApprovalScope, RunArtifactResponse } from "@atoms/contracts";
import { z } from "zod";

// The subset of Emma's output (packages/agents EmmaOutputSchema) that the customer
// reviews at plan approval. The web app does not depend on @atoms/agents, so this
// is a deliberately loose mirror: it must accept anything Emma can produce.
const PlanRequirementsSchema = z.object({
  productName: z.string(),
  problemStatement: z.string(),
  targetUsers: z.array(z.string()),
  userStories: z.array(
    z.object({
      id: z.string(),
      role: z.string(),
      goal: z.string(),
      benefit: z.string(),
      acceptanceCriteria: z.array(z.string()),
    }),
  ),
  nonGoals: z.array(z.string()),
  assumptions: z.array(z.string()),
});

export type PlanApprovalSummary = z.infer<typeof PlanRequirementsSchema>;

/**
 * The requirements the agents derived from the prompt and any attachments, for the
 * customer to read before approving the plan. Returns the latest Emma output, or
 * null when it is missing or not in the expected shape; callers must then say so
 * rather than show an empty list.
 */
export function extractPlanApprovalSummary(
  artifacts: readonly RunArtifactResponse[],
): PlanApprovalSummary | null {
  const candidates = artifacts
    .filter(
      (artifact) =>
        artifact.payload.artifactType === "emma-output" &&
        artifact.content !== null,
    )
    .sort((left, right) => right.sequence - left.sequence);

  for (const artifact of candidates) {
    const parsed = PlanRequirementsSchema.safeParse(artifact.content);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** Only the plan approval carries the requirements review; content approval is unchanged. */
export function requiresRequirementsConfirmation(
  scope: ApprovalScope | undefined,
): boolean {
  return scope === "plan";
}

/** Approve stays disabled until the customer has confirmed, when confirmation is required. */
export function canApprove(
  scope: ApprovalScope | undefined,
  requirementsConfirmed: boolean,
): boolean {
  return !requiresRequirementsConfirmation(scope) || requirementsConfirmed;
}

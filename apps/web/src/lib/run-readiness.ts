import {
  CreateRunInputSchema,
  type CreateProjectInput,
  type ListWorkspacesResponse,
  type ProjectResponse,
} from "@atoms/contracts";

import {
  createProjectAndVerify,
  type ProjectReadinessClient,
} from "./project-readiness";

export const LIVE_PROVIDER_CONFIRMATION =
  "I_ACCEPT_ONE_LIVE_OPENAI_E2B_STAGING_RUN";
export const MAX_ALLOWED_COST_CAD = 4;

export interface RunReadinessClient extends ProjectReadinessClient {
  listWorkspaces(): Promise<ListWorkspacesResponse>;
}

export interface RunReadinessDraft {
  readonly workspaceId: string;
  readonly projectName: string;
  readonly projectSlug: string;
  readonly prompt: string;
  readonly maximumCostCad: number;
  readonly providerConfirmation: string;
}

export interface PreparedRunReadiness {
  readonly project: ProjectResponse;
  readonly prompt: string;
  readonly maximumCostCad: number;
  readonly providerConfirmation: typeof LIVE_PROVIDER_CONFIRMATION;
}

export function validateLiveRunConsent(input: {
  readonly prompt: string;
  readonly maximumCostCad: number;
  readonly providerConfirmation: string;
}): {
  readonly violations: readonly string[];
  readonly normalizedPrompt?: string;
} {
  const violations: string[] = [];
  const parsedRun = CreateRunInputSchema.safeParse({
    prompt: input.prompt,
    attachmentIds: [],
  });

  if (!parsedRun.success) {
    violations.push("Prompt must contain between 1 and 100,000 characters.");
  }
  if (
    !Number.isFinite(input.maximumCostCad) ||
    input.maximumCostCad <= 0 ||
    input.maximumCostCad > MAX_ALLOWED_COST_CAD
  ) {
    violations.push(
      `Maximum cost must be greater than CAD 0 and no more than CAD ${String(MAX_ALLOWED_COST_CAD)}.`,
    );
  }
  if (input.providerConfirmation !== LIVE_PROVIDER_CONFIRMATION) {
    violations.push(
      `Provider confirmation must exactly equal ${LIVE_PROVIDER_CONFIRMATION}.`,
    );
  }

  return parsedRun.success
    ? { violations, normalizedPrompt: parsedRun.data.prompt }
    : { violations };
}

export async function prepareRunReadiness(
  client: RunReadinessClient,
  draft: RunReadinessDraft,
  options?: { readonly slugSuffix?: string },
): Promise<PreparedRunReadiness> {
  const consent = validateLiveRunConsent(draft);
  if (consent.violations.length > 0 || consent.normalizedPrompt === undefined) {
    throw new Error(consent.violations.join(" "));
  }

  const input: CreateProjectInput = {
    workspaceId: draft.workspaceId,
    name: draft.projectName.trim(),
    slug: draft.projectSlug.trim(),
    description:
      "Prepared by the Atoms non-billable run-readiness surface; no run requested",
  };

  const project = await createProjectAndVerify(client, input, options);

  return {
    project,
    prompt: consent.normalizedPrompt,
    maximumCostCad: draft.maximumCostCad,
    providerConfirmation: LIVE_PROVIDER_CONFIRMATION,
  };
}

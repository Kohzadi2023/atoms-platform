import {
  CreateRunInputSchema,
  type CreateProjectInput,
  type ListWorkspacesResponse,
  type ProjectResponse,
} from "@atoms/contracts";

export const LIVE_PROVIDER_CONFIRMATION =
  "I_ACCEPT_ONE_LIVE_OPENAI_E2B_STAGING_RUN";
export const MAX_ALLOWED_COST_CAD = 4;
const DEFAULT_READINESS_SLUG = "readiness-project";

export interface RunReadinessClient {
  listWorkspaces(): Promise<ListWorkspacesResponse>;
  createProject(input: CreateProjectInput): Promise<ProjectResponse>;
  getProject(projectId: string, signal?: AbortSignal): Promise<ProjectResponse>;
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

export function createUniqueRunReadinessSlug(baseSlug: string, suffix: string): string {
  const normalizedSuffix = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "")
    .slice(0, 16);
  if (normalizedSuffix.length === 0) {
    throw new Error("Run readiness slug suffix must contain letters or numbers");
  }
  const maxBaseLength = 100 - normalizedSuffix.length - 1;
  const normalizedBase = baseSlug.slice(0, maxBaseLength).replace(/-+$/gu, "");
  return `${normalizedBase}-${normalizedSuffix}`;
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

  const requestedSlug = draft.projectSlug.trim();
  const requestInput: CreateProjectInput = {
    workspaceId: draft.workspaceId,
    name: draft.projectName.trim(),
    slug:
      requestedSlug === DEFAULT_READINESS_SLUG
        ? createUniqueRunReadinessSlug(
            requestedSlug,
            options?.slugSuffix ?? globalThis.crypto.randomUUID().slice(0, 8),
          )
        : requestedSlug,
    description:
      "Prepared by the Atoms non-billable run-readiness surface; no run requested",
  };

  const created = await client.createProject(requestInput);
  const project = await client.getProject(created.id);
  if (
    project.id !== created.id ||
    project.workspaceId !== requestInput.workspaceId ||
    project.slug !== requestInput.slug
  ) {
    throw new Error("Prepared project could not be verified against its workspace and slug");
  }

  return {
    project,
    prompt: consent.normalizedPrompt,
    maximumCostCad: draft.maximumCostCad,
    providerConfirmation: LIVE_PROVIDER_CONFIRMATION,
  };
}

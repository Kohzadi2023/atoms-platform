import type {
  CreateProjectInput,
  ListWorkspacesResponse,
  ProjectResponse,
} from "@atoms/contracts";

const DEFAULT_READINESS_SLUG = "readiness-project";

export interface ProjectReadinessClient {
  listWorkspaces(): Promise<ListWorkspacesResponse>;
  createProject(input: CreateProjectInput): Promise<ProjectResponse>;
  getProject(projectId: string, signal?: AbortSignal): Promise<ProjectResponse>;
}

export function createUniqueReadinessSlug(baseSlug: string, suffix: string): string {
  const normalizedSuffix = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "")
    .slice(0, 16);

  if (normalizedSuffix.length === 0) {
    throw new Error("Readiness project slug suffix must contain letters or numbers");
  }

  const maxBaseLength = 100 - normalizedSuffix.length - 1;
  const normalizedBase = baseSlug.slice(0, maxBaseLength).replace(/-+$/gu, "");
  return `${normalizedBase}-${normalizedSuffix}`;
}

export async function createProjectAndVerify(
  client: ProjectReadinessClient,
  input: CreateProjectInput,
  options?: { readonly slugSuffix?: string },
): Promise<ProjectResponse> {
  const requestInput =
    input.slug === DEFAULT_READINESS_SLUG
      ? {
          ...input,
          slug: createUniqueReadinessSlug(
            input.slug,
            options?.slugSuffix ?? globalThis.crypto.randomUUID().slice(0, 8),
          ),
        }
      : input;

  const created = await client.createProject(requestInput);
  const verified = await client.getProject(created.id);

  if (
    verified.id !== created.id ||
    verified.workspaceId !== requestInput.workspaceId ||
    verified.slug !== requestInput.slug
  ) {
    throw new Error("Created project could not be verified against its workspace and slug");
  }

  return verified;
}

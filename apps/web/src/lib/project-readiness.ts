import type {
  CreateProjectInput,
  ListWorkspacesResponse,
  ProjectResponse,
} from "@atoms/contracts";

export interface ProjectReadinessClient {
  listWorkspaces(): Promise<ListWorkspacesResponse>;
  createProject(input: CreateProjectInput): Promise<ProjectResponse>;
  getProject(projectId: string, signal?: AbortSignal): Promise<ProjectResponse>;
}

export async function createProjectAndVerify(
  client: ProjectReadinessClient,
  input: CreateProjectInput,
): Promise<ProjectResponse> {
  const created = await client.createProject(input);
  const verified = await client.getProject(created.id);

  if (
    verified.id !== created.id ||
    verified.workspaceId !== input.workspaceId ||
    verified.slug !== input.slug
  ) {
    throw new Error("Created project could not be verified against its workspace and slug");
  }

  return verified;
}

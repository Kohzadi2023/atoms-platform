import type { ProjectType } from "@atoms/contracts";

export interface ProjectTypeOption {
  readonly value: ProjectType;
  readonly label: string;
  readonly description: string;
}

export const PROJECT_TYPE_OPTIONS: readonly ProjectTypeOption[] = [
  {
    value: "GENERAL",
    label: "General application",
    description:
      "Full product route. Premium workspace plans can also run market research, SEO, and growth copy agents.",
  },
  {
    value: "CLIENT_PORTAL",
    label: "Agency client portal",
    description:
      "Operational client portal route: planning, requirements, architecture, implementation, validation, and data work without market, SEO, or growth agents.",
  },
] as const;

export function projectTypeOption(projectType: ProjectType): ProjectTypeOption {
  const option = PROJECT_TYPE_OPTIONS.find(({ value }) => value === projectType);
  if (option === undefined) {
    throw new Error(`Unsupported project type: ${String(projectType)}`);
  }
  return option;
}

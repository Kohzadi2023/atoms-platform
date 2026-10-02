import { Template } from "@e2b/code-interpreter";

/**
 * The foundational E2B template every other template in this package layers on
 * (see viability-template.ts and local-database-template.ts's own comments,
 * which both assume "the base validation template" already exists). Node.js
 * ships in the base Docker image; this only adds the pinned package manager
 * every generated project is validated with.
 *
 * Found missing live (docs/adr/production-execution-gate.md's pilot): with no
 * E2B_TEMPLATE configured, the sandbox fell back to E2B's own default image,
 * which has neither Node.js nor pnpm -- `pnpm install` failed with exit 127
 * ("command not found") on every run that reached the validation step.
 */

/** Matches the monorepo's own pinned package manager (see package.json's "packageManager"). */
export const BASE_TEMPLATE_PNPM_VERSION = "11.7.0";

/**
 * Starts from E2B's Node.js image (Node.js preinstalled; default variant is
 * the current LTS) and activates the pinned pnpm via corepack, which ships
 * with Node.js itself -- no extra package manager install needed.
 */
export function buildBaseTemplate() {
  return Template()
    .fromNodeImage()
    .runCmd(
      [
        "corepack enable",
        `corepack prepare pnpm@${BASE_TEMPLATE_PNPM_VERSION} --activate`,
      ],
      { user: "root" },
    );
}

/** The steps the build would run, in the form the E2B API receives. Nothing is sent. */
export async function describeBaseTemplate(): Promise<{
  readonly fromTemplate: string;
  readonly stepTypes: readonly string[];
}> {
  const parsed = JSON.parse(await Template.toJSON(buildBaseTemplate(), false)) as {
    fromTemplate: string;
    steps: Array<{ type: string }>;
  };
  return {
    fromTemplate: parsed.fromTemplate,
    stepTypes: parsed.steps.map((step) => step.type),
  };
}

/** Builds and registers the template on E2B. Billable and needs network. */
export async function buildBaseTemplateOnE2B(options: {
  readonly name: string;
  readonly apiKey: string;
  readonly onLog?: (line: string) => void;
}): Promise<{ readonly name: string; readonly templateId: string }> {
  const info = await Template.build(buildBaseTemplate(), {
    alias: options.name,
    apiKey: options.apiKey,
    cpuCount: 2,
    memoryMB: 4096,
    ...(options.onLog === undefined
      ? {}
      : { onBuildLogs: (entry: { toString(): string }) => options.onLog?.(entry.toString()) }),
  });
  return { name: info.name ?? options.name, templateId: info.templateId };
}

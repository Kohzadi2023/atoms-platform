import { Template } from "@e2b/code-interpreter";

import {
  DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
  DEFAULT_PLAYWRIGHT_ENTRY,
} from "./preview-viability-script.js";

/** Pinned so a template rebuild cannot silently change the browser. */
export const VIABILITY_PLAYWRIGHT_VERSION = "1.63.0";

export const VIABILITY_DIRECTORY = "/opt/atoms-viability";

/**
 * The E2B template definition for the browser viability check
 * (docs/adr/production-execution-gate.md, G7): the existing validation template
 * plus Playwright and Chromium, installed where DEFAULT_PLAYWRIGHT_ENTRY expects.
 *
 * It layers on `baseTemplate` rather than replacing it, so whatever Node, pnpm and
 * system packages that template provides for generated projects stay as they are.
 * The build needs outbound network access; the running sandbox does not.
 */
export function buildViabilityTemplate(baseTemplate: string) {
  if (baseTemplate.trim().length === 0) {
    throw new RangeError("a base template name is required");
  }
  return Template()
    .fromTemplate(baseTemplate)
    .setEnvs({ PLAYWRIGHT_BROWSERS_PATH: DEFAULT_PLAYWRIGHT_BROWSERS_PATH })
    .runCmd(
      [
        `mkdir -p ${VIABILITY_DIRECTORY}`,
        `cd ${VIABILITY_DIRECTORY} && npm init -y && npm install --no-audit --no-fund playwright@${VIABILITY_PLAYWRIGHT_VERSION}`,
        `cd ${VIABILITY_DIRECTORY} && npx playwright install --with-deps chromium`,
        `chmod -R a+rX ${VIABILITY_DIRECTORY}`,
      ],
      { user: "root" },
    );
}

/** The steps the build would run, in the form the E2B API receives. Nothing is sent. */
export async function describeViabilityTemplate(
  baseTemplate: string,
): Promise<{ readonly fromTemplate: string; readonly stepTypes: readonly string[] }> {
  const parsed = JSON.parse(
    await Template.toJSON(buildViabilityTemplate(baseTemplate), false),
  ) as { fromTemplate: string; steps: Array<{ type: string }> };
  return {
    fromTemplate: parsed.fromTemplate,
    stepTypes: parsed.steps.map((step) => step.type),
  };
}

/** Builds and registers the template on E2B. Billable and needs network. */
export async function buildViabilityTemplateOnE2B(options: {
  readonly baseTemplate: string;
  readonly name: string;
  readonly apiKey: string;
  readonly onLog?: (line: string) => void;
}): Promise<{ readonly name: string; readonly templateId: string }> {
  const info = await Template.build(buildViabilityTemplate(options.baseTemplate), {
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

export { DEFAULT_PLAYWRIGHT_BROWSERS_PATH, DEFAULT_PLAYWRIGHT_ENTRY };

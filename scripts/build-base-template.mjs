// Builds the foundational E2B template with Node.js and the monorepo's pinned pnpm
// (docs/adr/production-execution-gate.md's pilot, found missing live: with no
// E2B_TEMPLATE configured, sandbox validation fell back to E2B's default image,
// which has neither, and every run's install step failed with exit 127).
//
//   node scripts/build-base-template.mjs [--name <name>]                  (dry run: prints the plan)
//   E2B_API_KEY=... node scripts/build-base-template.mjs --build [--name <name>]   (builds it)
//
// Without --build nothing is sent to E2B. After a successful build, set
// E2B_TEMPLATE on the worker to the new name -- or, to also add the browser
// viability check, pass this template's name as --base to
// build-viability-template.mjs first.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function parseArguments(argv) {
  const options = { name: "atoms-base-validation", build: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--build") options.build = true;
    else if (argument === "--name") options.name = argv[(index += 1)];
    else throw new RangeError(`unknown argument: ${argument}`);
  }
  options.name = options.name?.trim();
  if (typeof options.name !== "string" || options.name.length === 0) {
    throw new RangeError("--name must not be empty");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(options.name)) {
    throw new RangeError("--name must be a template name of letters, digits, dot, dash or underscore");
  }
  return options;
}

export async function run(
  argv,
  { environment = process.env, write = console.log, loadSandboxProvider = () => import("../packages/sandbox-provider/dist/index.js") } = {},
) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    write(`usage error: ${error.message}`);
    return 2;
  }

  const sandbox = await loadSandboxProvider();
  const plan = await sandbox.describeBaseTemplate();

  write(`New template:    ${options.name}`);
  write(`Base image:      Node.js (E2B fromNodeImage)`);
  write(`pnpm:            ${sandbox.BASE_TEMPLATE_PNPM_VERSION}, via corepack`);
  write(`Steps:           ${plan.stepTypes.join(", ")}`);

  if (!options.build) {
    write("Dry run: nothing was sent to E2B. Add --build to build the template.");
    return 0;
  }
  const apiKey = environment.E2B_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    write("E2B_API_KEY is not set; refusing to build.");
    return 2;
  }
  const built = await sandbox.buildBaseTemplateOnE2B({
    name: options.name,
    apiKey,
    onLog: write,
  });
  write(`Built template ${built.name} (${built.templateId}).`);
  write(`Next: set E2B_TEMPLATE=${options.name} on the worker, then retry the run.`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}

// Builds the E2B template that carries a local, ephemeral PostgreSQL server so a
// generated app that needs a database (sign-in, saved data) is usable in its preview.
//
//   node scripts/build-local-database-template.mjs --base <existing-template> [--name <new-name>]          (dry run: prints the plan)
//   E2B_API_KEY=... node scripts/build-local-database-template.mjs --base <existing-template> --build      (builds it)
//
// It layers on the existing validation template, so the projects it validates keep
// the Node, pnpm and system packages they already had. The server is installed and
// initialised at build time and only started inside a run's sandbox, where it is
// reachable from that sandbox alone. Without --build nothing is sent to E2B. After a
// successful build, set E2B_TEMPLATE on the worker to the new name and
// PREVIEW_LOCAL_DATABASE=required.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function parseArguments(argv, environment = process.env) {
  const options = { base: environment.E2B_TEMPLATE, name: undefined, build: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--build") options.build = true;
    else if (argument === "--base") options.base = argv[(index += 1)];
    else if (argument === "--name") options.name = argv[(index += 1)];
    else throw new RangeError(`unknown argument: ${argument}`);
  }
  if (typeof options.base !== "string" || options.base.trim().length === 0) {
    throw new RangeError("--base (or E2B_TEMPLATE) is required: the template to layer PostgreSQL onto");
  }
  options.base = options.base.trim();
  options.name = (options.name ?? `${options.base}-db`).trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(options.name)) {
    throw new RangeError("--name must be a template name of letters, digits, dot, dash or underscore");
  }
  if (options.name === options.base) {
    throw new RangeError("--name must differ from --base so the existing template is not overwritten");
  }
  return options;
}

export async function run(
  argv,
  { environment = process.env, write = console.log, loadSandboxProvider = () => import("../packages/sandbox-provider/dist/index.js") } = {},
) {
  let options;
  try {
    options = parseArguments(argv, environment);
  } catch (error) {
    write(`usage error: ${error.message}`);
    return 2;
  }

  const sandbox = await loadSandboxProvider();
  const plan = await sandbox.describeLocalDatabaseTemplate(options.base);

  write(`Base template:   ${options.base}`);
  write(`New template:    ${options.name}`);
  write(`Database:        ${sandbox.LOCAL_DATABASE_APT_PACKAGE} (apt), port ${String(sandbox.LOCAL_DATABASE_PORT)}, sandbox-local only`);
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
  const built = await sandbox.buildLocalDatabaseTemplateOnE2B({
    baseTemplate: options.base,
    name: options.name,
    apiKey,
    onLog: write,
  });
  write(`Built template ${built.name} (${built.templateId}).`);
  write(`Next: set E2B_TEMPLATE=${options.name} and PREVIEW_LOCAL_DATABASE=required on the worker.`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}

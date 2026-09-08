import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const ENTRA_TENANT_PLAN_CONFIRMATION = "PLAN_ATOMS_ENTRA_EXTERNAL_TENANT";
export const ENTRA_TENANT_APPLY_CONFIRMATION = "CREATE_ATOMS_ENTRA_EXTERNAL_TENANT";

export const ENTRA_STAGING_BOUNDARY = Object.freeze({
  subscriptionId: "2ac8ed24-166b-4325-89dc-829d64391ce9",
  forbiddenSubscriptionId: "bbcaf423-9a71-43bc-9fc7-821ef012cd01",
  workforceTenantId: "0cdabe1c-fd18-4c8b-8766-c371f1cd0691",
  resourceGroup: "atoms-staging-rg",
  apiVersion: "2023-05-17-preview",
  countryCode: "CA",
  resourceLocation: "United States",
  displayName: "Atoms Staging Customers",
  candidateNames: ["atomsstaging91ce9", "atomsstg91ce9", "atomsdev91ce9"],
});

const defaultDependencies = {
  run: runProcess,
  log: (message) => console.log(message),
};

export function parseArguments(arguments_) {
  const args = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const options = { mode: "plan" };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (!["--mode", "--confirmation"].includes(name)) {
      throw new Error(`Unknown Entra tenant bootstrap argument: ${name}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    if (name === "--mode") options.mode = value;
    if (name === "--confirmation") options.confirmation = value;
    index += 1;
  }
  validateOptions(options);
  return options;
}

export function validateOptions(options) {
  if (!new Set(["plan", "apply"]).has(options.mode)) {
    throw new Error("--mode must be plan or apply");
  }
  const expected =
    options.mode === "apply"
      ? ENTRA_TENANT_APPLY_CONFIRMATION
      : ENTRA_TENANT_PLAN_CONFIRMATION;
  if (options.confirmation !== expected) {
    throw new Error(`--confirmation must equal ${expected}`);
  }
}

export function buildCheckNameUrl(boundary = ENTRA_STAGING_BOUNDARY) {
  return `https://management.azure.com/subscriptions/${boundary.subscriptionId}/providers/Microsoft.AzureActiveDirectory/checkNameAvailability?api-version=${boundary.apiVersion}`;
}

export function buildTenantUrl(resourceName, boundary = ENTRA_STAGING_BOUNDARY) {
  if (!/^[A-Za-z0-9]{1,26}$/u.test(resourceName)) {
    throw new Error("External tenant resource name must be 1-26 alphanumeric characters");
  }
  return `https://management.azure.com/subscriptions/${boundary.subscriptionId}/resourceGroups/${boundary.resourceGroup}/providers/Microsoft.AzureActiveDirectory/ciamDirectories/${resourceName}?api-version=${boundary.apiVersion}`;
}

export function buildTenantCreateBody(resourceName, boundary = ENTRA_STAGING_BOUNDARY) {
  if (!/^[A-Za-z0-9]{1,26}$/u.test(resourceName)) {
    throw new Error("External tenant resource name must be 1-26 alphanumeric characters");
  }
  return {
    location: boundary.resourceLocation,
    sku: { name: "Standard", tier: "A0" },
    properties: {
      createTenantProperties: {
        displayName: boundary.displayName,
        countryCode: boundary.countryCode,
      },
    },
    tags: {
      project: "atoms",
      environment: "staging",
      purpose: "customer-identity",
    },
  };
}

export function buildNameCheckBody(resourceName, boundary = ENTRA_STAGING_BOUNDARY) {
  return { name: resourceName, countryCode: boundary.countryCode };
}

async function restJson(dependencies, method, url, body) {
  let root;
  try {
    const args = [
      "rest",
      "--method",
      method.toLowerCase(),
      "--url",
      url,
      "--only-show-errors",
      "--output",
      "json",
    ];
    if (body !== undefined) {
      root = await mkdtemp(join(tmpdir(), "atoms-entra-rest-"));
      const bodyPath = join(root, "body.json");
      await writeFile(bodyPath, JSON.stringify(body), "utf8");
      args.push("--body", `@${bodyPath}`);
    }
    const output = dependencies.run("az", args);
    return output.trim().length === 0 ? undefined : JSON.parse(output);
  } finally {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
}

function validateAccount(account, boundary = ENTRA_STAGING_BOUNDARY) {
  if (account.id?.toLowerCase() === boundary.forbiddenSubscriptionId.toLowerCase()) {
    throw new Error("Refusing to use the forbidden legacy Azure subscription");
  }
  if (account.id?.toLowerCase() !== boundary.subscriptionId.toLowerCase()) {
    throw new Error("Azure account is not locked to the dedicated Atoms-Staging subscription");
  }
  if (account.state !== "Enabled") {
    throw new Error("Atoms-Staging subscription is not enabled");
  }
}

async function listExistingTenants(dependencies, boundary = ENTRA_STAGING_BOUNDARY) {
  const url = `https://management.azure.com/subscriptions/${boundary.subscriptionId}/resourceGroups/${boundary.resourceGroup}/providers/Microsoft.AzureActiveDirectory/ciamDirectories?api-version=${boundary.apiVersion}`;
  const response = await restJson(dependencies, "GET", url);
  return Array.isArray(response?.value) ? response.value : [];
}

export async function bootstrapEntraExternalTenant(options, dependencies = defaultDependencies) {
  validateOptions(options);
  const boundary = ENTRA_STAGING_BOUNDARY;

  dependencies.run("az", ["account", "set", "--subscription", boundary.subscriptionId]);
  const account = JSON.parse(
    dependencies.run("az", [
      "account",
      "show",
      "--output",
      "json",
      "--only-show-errors",
    ]),
  );
  validateAccount(account, boundary);

  dependencies.run("az", [
    "group",
    "show",
    "--subscription",
    boundary.subscriptionId,
    "--name",
    boundary.resourceGroup,
    "--output",
    "none",
    "--only-show-errors",
  ]);
  dependencies.run("az", [
    "provider",
    "register",
    "--subscription",
    boundary.subscriptionId,
    "--namespace",
    "Microsoft.AzureActiveDirectory",
    "--wait",
    "--only-show-errors",
  ]);

  const existing = await listExistingTenants(dependencies, boundary);
  if (existing.length > 1) {
    throw new Error("More than one external tenant resource exists in atoms-staging-rg");
  }
  if (existing.length === 1) {
    dependencies.log(`Existing external tenant resource found: ${existing[0].name}`);
    return { created: false, resource: existing[0] };
  }

  let selected;
  for (const candidate of boundary.candidateNames) {
    const availability = await restJson(
      dependencies,
      "POST",
      buildCheckNameUrl(boundary),
      buildNameCheckBody(candidate, boundary),
    );
    if (availability?.nameAvailable === true) {
      selected = candidate;
      break;
    }
  }
  if (selected === undefined) {
    throw new Error("No deterministic Atoms external tenant domain is available");
  }

  dependencies.log(`Selected tenant domain: ${selected}.onmicrosoft.com`);
  if (options.mode === "plan") {
    return { created: false, plannedResourceName: selected };
  }

  const resource = await restJson(
    dependencies,
    "PUT",
    buildTenantUrl(selected, boundary),
    buildTenantCreateBody(selected, boundary),
  );
  return { created: true, resource };
}

function runProcess(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    input: options.input,
    shell: false,
    env: process.env,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function main(arguments_ = process.argv.slice(2)) {
  const options = parseArguments(arguments_);
  const result = await bootstrapEntraExternalTenant(options);
  console.log(JSON.stringify(result, null, 2));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();

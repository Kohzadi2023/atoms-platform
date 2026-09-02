import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export const AZURE_STAGING_PLAN_CONFIRMATION =
  "PLAN_DEDICATED_ATOMS_AZURE_STAGING";
export const AZURE_STAGING_DEPLOY_CONFIRMATION =
  "PROVISION_DEDICATED_ATOMS_AZURE_STAGING";

const EXPECTED_CONFIRMATIONS = new Map([
  ["what-if", AZURE_STAGING_PLAN_CONFIRMATION],
  ["deploy", AZURE_STAGING_DEPLOY_CONFIRMATION],
]);

function normalized(value) {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length === 0 ? undefined : result;
}

function isNarrowIpv4Cidr(value) {
  if (value === undefined) return false;
  const [address, prefix, ...rest] = value.split("/");
  if (rest.length > 0 || isIP(address) !== 4 || !/^\d{1,2}$/u.test(prefix ?? "")) {
    return false;
  }
  const prefixLength = Number(prefix);
  return prefixLength >= 24 && prefixLength <= 32;
}

function isSshPublicKey(value) {
  if (value === undefined || value.length > 16_384) return false;
  return /^ssh-(?:ed25519|rsa) [A-Za-z0-9+/]{32,}={0,3}(?: [^\r\n]+)?$/u.test(
    value,
  );
}

function isEmail(value) {
  if (value === undefined || value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function isUuid(value) {
  if (value === undefined) return false;
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);
}

export function validateAzureStagingInputs(environment) {
  const violations = [];
  const mode = normalized(environment.AZURE_STAGING_MODE);
  const expectedConfirmation = EXPECTED_CONFIRMATIONS.get(mode);

  if (expectedConfirmation === undefined) {
    violations.push("AZURE_STAGING_MODE must be what-if or deploy");
  } else if (environment.AZURE_STAGING_CONFIRMATION !== expectedConfirmation) {
    violations.push(`AZURE_STAGING_CONFIRMATION must exactly match the ${mode} acknowledgement`);
  }

  const changeTicket = normalized(environment.AZURE_STAGING_CHANGE_TICKET);
  if (changeTicket === undefined || !/^GH-[1-9]\d{0,9}$/u.test(changeTicket)) {
    violations.push("AZURE_STAGING_CHANGE_TICKET must be a normalized GH issue reference");
  }

  if (environment.AZURE_STAGING_MAX_MONTHLY_COST_CAD !== "80") {
    violations.push("AZURE_STAGING_MAX_MONTHLY_COST_CAD must exactly equal 80");
  }
  if (environment.AZURE_STAGING_LOCATION !== "canadacentral") {
    violations.push("AZURE_STAGING_LOCATION must exactly equal canadacentral");
  }
  if (environment.AZURE_STAGING_RESOURCE_GROUP !== "atoms-staging-rg") {
    violations.push("AZURE_STAGING_RESOURCE_GROUP must exactly equal atoms-staging-rg");
  }
  if (environment.AZURE_STAGING_VM_SIZE !== "Standard_B2s_v2") {
    violations.push("AZURE_STAGING_VM_SIZE must exactly equal Standard_B2s_v2");
  }
  if (!isNarrowIpv4Cidr(normalized(environment.AZURE_STAGING_SSH_SOURCE_CIDR))) {
    violations.push("AZURE_STAGING_SSH_SOURCE_CIDR must be one IPv4 CIDR between /24 and /32");
  }
  if (!isSshPublicKey(normalized(environment.AZURE_STAGING_SSH_PUBLIC_KEY))) {
    violations.push("AZURE_STAGING_SSH_PUBLIC_KEY must be a valid RSA or Ed25519 public key");
  }
  if (!isEmail(normalized(environment.AZURE_BUDGET_CONTACT_EMAIL))) {
    violations.push("AZURE_BUDGET_CONTACT_EMAIL must be a valid budget notification address");
  }
  for (const name of [
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "AZURE_SUBSCRIPTION_ID",
  ]) {
    if (!isUuid(normalized(environment[name]))) {
      violations.push(`${name} must be a UUID`);
    }
  }

  return {
    ok: violations.length === 0,
    mode,
    violations,
  };
}

export function main(environment = process.env) {
  const result = validateAzureStagingInputs(environment);
  if (!result.ok) {
    console.error("Azure staging host preflight failed:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    console.error("No Azure resource operation was attempted.");
    process.exitCode = 1;
    return result;
  }

  console.log(
    `Azure staging host preflight passed (${result.mode}; dedicated resource group; CAD 80 monthly budget).`,
  );
  return result;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();

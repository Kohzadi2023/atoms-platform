import { pathToFileURL } from "node:url";

const API_VERSION = "2022-11-28";

export class EnvironmentProtectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnvironmentProtectionError";
  }
}

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EnvironmentProtectionError(`${name} must be configured.`);
  }

  return value.trim();
}

export function buildEnvironmentApiUrl({
  apiUrl = "https://api.github.com",
  environmentName,
  repository,
}) {
  const normalizedApiUrl = requireNonEmpty(apiUrl, "GITHUB_API_URL").replace(/\/$/u, "");
  const parsedApiUrl = new URL(normalizedApiUrl);

  if (parsedApiUrl.protocol !== "https:") {
    throw new EnvironmentProtectionError("GITHUB_API_URL must use HTTPS.");
  }

  const repositoryParts = requireNonEmpty(repository, "GITHUB_REPOSITORY").split("/");
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => part === "")) {
    throw new EnvironmentProtectionError("GITHUB_REPOSITORY must use the owner/repository format.");
  }

  const normalizedEnvironmentName = requireNonEmpty(
    environmentName,
    "PHASE3_STAGING_ENVIRONMENT",
  );
  const [owner, repositoryName] = repositoryParts;

  return `${normalizedApiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repositoryName,
  )}/environments/${encodeURIComponent(normalizedEnvironmentName)}`;
}

export function evaluateEnvironmentProtection(payload, expectedEnvironmentName) {
  const violations = [];
  const environmentName = requireNonEmpty(
    expectedEnvironmentName,
    "PHASE3_STAGING_ENVIRONMENT",
  );

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new EnvironmentProtectionError("GitHub returned invalid environment metadata.");
  }

  if (payload.name !== environmentName) {
    violations.push("the returned environment name does not match the requested environment");
  }

  const protectionRules = Array.isArray(payload.protection_rules)
    ? payload.protection_rules
    : [];
  const reviewerRule = protectionRules.find((rule) => rule?.type === "required_reviewers");

  if (!reviewerRule) {
    violations.push("a required-reviewer rule is not configured");
  } else {
    if (!Array.isArray(reviewerRule.reviewers) || reviewerRule.reviewers.length === 0) {
      violations.push("the required-reviewer rule has no reviewers");
    }

    if (reviewerRule.prevent_self_review !== true) {
      violations.push("self-review prevention is not enabled");
    }
  }

  if (payload.can_admins_bypass !== false) {
    violations.push("administrator bypass is not disabled");
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

export async function verifyEnvironmentProtection({
  apiUrl = "https://api.github.com",
  environmentName,
  fetchImpl = globalThis.fetch,
  repository,
  token,
}) {
  if (typeof fetchImpl !== "function") {
    throw new EnvironmentProtectionError("A Fetch API implementation is required.");
  }

  const url = buildEnvironmentApiUrl({ apiUrl, environmentName, repository });
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "atoms-phase3-environment-guard",
    "X-GitHub-Api-Version": API_VERSION,
  };

  if (typeof token === "string" && token.trim() !== "") {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch {
    throw new EnvironmentProtectionError("GitHub environment metadata could not be retrieved.");
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : "";
    throw new EnvironmentProtectionError(
      `GitHub environment metadata request failed${status}.`,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new EnvironmentProtectionError("GitHub returned invalid environment metadata.");
  }

  const result = evaluateEnvironmentProtection(payload, environmentName);
  if (!result.ok) {
    throw new EnvironmentProtectionError(
      `The live provider environment is not safely protected: ${result.violations.join("; ")}.`,
    );
  }

  return result;
}

export async function main(environment = process.env) {
  const environmentName = environment.PHASE3_STAGING_ENVIRONMENT;

  await verifyEnvironmentProtection({
    apiUrl: environment.GITHUB_API_URL,
    environmentName,
    repository: environment.GITHUB_REPOSITORY,
    token: environment.GITHUB_TOKEN,
  });

  console.log(
    `Phase 3 environment protection verified for ${environmentName}: reviewer approval required, self-review blocked, and administrator bypass disabled.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    const message =
      error instanceof EnvironmentProtectionError
        ? error.message
        : "An unexpected environment protection error occurred.";
    console.error(`Phase 3 environment protection check failed: ${message}`);
    process.exitCode = 1;
  });
}

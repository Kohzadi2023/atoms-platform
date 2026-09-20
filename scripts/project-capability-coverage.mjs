// The agents each project type needs are defined once, in PROJECT_TYPE_AGENTS in
// @atoms/contracts (the worker routes on it). This matrix adds capability names and which
// agents are premium so a coverage failure reads in capability terms; a test keeps it from
// drifting from the contracts table.
const PROJECT_CAPABILITIES = Object.freeze({
  GENERAL: Object.freeze([
    ["market-research", "Sophia", true],
    ["product-planning", "Mike", false],
    ["requirements", "Emma", false],
    ["architecture", "Bob", false],
    ["implementation", "Alex", false],
    ["data-design", "David", false],
    ["seo", "Sarah", true],
    ["growth-copy", "Adrian", true],
  ]),
  CLIENT_PORTAL: Object.freeze([
    ["product-planning", "Mike", false],
    ["requirements", "Emma", false],
    ["architecture", "Bob", false],
    ["implementation", "Alex", false],
    ["data-design", "David", false],
  ]),
});

const SUPPORTED_PLANS = new Set(["FREE", "PRO", "MAX"]);

export function projectRequiresWorkspacePlan(projectType) {
  return projectCapabilities(projectType).some(([, , premium]) => premium);
}

export function requiredCapabilityAgents(projectType, plan) {
  const capabilities = projectCapabilities(projectType);
  const requiresPlan = capabilities.some(([, , premium]) => premium);

  if (plan === undefined) {
    if (requiresPlan) {
      throw new Error(
        `workspace plan is required for project type: ${String(projectType)}`,
      );
    }
    return capabilities.map(([capability, agent]) => ({ capability, agent }));
  }
  if (!SUPPORTED_PLANS.has(plan)) {
    throw new Error(`unsupported workspace plan: ${String(plan)}`);
  }

  return capabilities
    .filter(([, , premium]) => !premium || plan !== "FREE")
    .map(([capability, agent]) => ({ capability, agent }));
}

export function assertCapabilityCoverage({ projectType, plan, artifactAgents }) {
  if (!(artifactAgents instanceof Set)) {
    throw new Error("artifactAgents must be a Set");
  }

  const required = requiredCapabilityAgents(projectType, plan);
  const missing = required.filter(({ agent }) => !artifactAgents.has(agent));
  if (missing.length > 0) {
    throw new Error(
      `run artifacts are missing required capability coverage: ${missing
        .map(({ capability, agent }) => `${capability} (${agent})`)
        .join(", ")}`,
    );
  }

  return required;
}

export function assertCapabilityRouting({ projectType, plan, artifactAgents }) {
  const required = assertCapabilityCoverage({ projectType, plan, artifactAgents });
  const expectedAgents = new Set(required.map(({ agent }) => agent));
  const unexpected = [...artifactAgents].filter((agent) => !expectedAgents.has(agent));
  if (unexpected.length > 0) {
    throw new Error(
      `run artifacts contain agents outside the required capability route: ${unexpected.join(", ")}`,
    );
  }
  return required;
}

function projectCapabilities(projectType) {
  const capabilities = PROJECT_CAPABILITIES[projectType];
  if (capabilities === undefined) {
    throw new Error(`unsupported project type: ${String(projectType)}`);
  }
  return capabilities;
}

export const PROJECT_CAPABILITY_MATRIX = PROJECT_CAPABILITIES;

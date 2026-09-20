const PROJECT_CAPABILITIES = Object.freeze({
  GENERAL: Object.freeze([
    ["market-research", "Sophia", true],
    ["product-planning", "Mike", false],
    ["requirements-architecture", "Emma", false],
    ["implementation", "Bob", false],
    ["validation", "Alex", false],
    ["data-design", "David", false],
    ["seo", "Sarah", true],
    ["growth-copy", "Adrian", true],
  ]),
  CLIENT_PORTAL: Object.freeze([
    ["product-planning", "Mike", false],
    ["requirements-architecture", "Emma", false],
    ["implementation", "Bob", false],
    ["validation", "Alex", false],
    ["data-design", "David", false],
  ]),
});

const SUPPORTED_PLANS = new Set(["FREE", "PRO", "MAX"]);

export function requiredCapabilityAgents(projectType, plan) {
  const capabilities = PROJECT_CAPABILITIES[projectType];
  if (capabilities === undefined) {
    throw new Error(`unsupported project type: ${String(projectType)}`);
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

export const PROJECT_CAPABILITY_MATRIX = PROJECT_CAPABILITIES;

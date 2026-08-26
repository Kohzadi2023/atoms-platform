import { pathToFileURL } from "node:url";

const REQUIRED_RUNTIME_VARIABLES = [
  "DATABASE_URL",
  "REDIS_URL",
  "OPENAI_API_KEY",
  "E2B_API_KEY",
  "PREVIEW_SIGNING_SECRET",
  "PREVIEW_BASE_DOMAIN",
  "PREVIEW_UI_ORIGIN",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "CLAMAV_HOST",
];

const OIDC_VARIABLES = [
  "AUTH_ISSUER_URL",
  "AUTH_AUDIENCE",
  "AUTH_JWKS_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
];

function normalized(value) {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length === 0 ? undefined : result;
}

function isPlaceholder(name, value) {
  if (value === undefined) return false;
  if (name === "OPENAI_API_KEY" || name === "E2B_API_KEY") {
    return /^(?:replace|your-|example|changeme)/iu.test(value);
  }
  if (name.includes("SUPABASE") || name.startsWith("AUTH_")) {
    return value.includes("your-project-ref");
  }
  return false;
}

function missingVariables(environment, names) {
  return names.filter((name) => {
    const value = normalized(environment[name]);
    return value === undefined || isPlaceholder(name, value);
  });
}

export function evaluateLocalDevelopmentEnvironment(environment) {
  const violations = [];
  const missingRuntime = missingVariables(environment, REQUIRED_RUNTIME_VARIABLES);

  if (environment.NODE_ENV !== undefined && environment.NODE_ENV !== "development") {
    violations.push("NODE_ENV must be development for the local launcher");
  }
  if (missingRuntime.length > 0) {
    violations.push(`missing runtime variables: ${missingRuntime.join(", ")}`);
  }

  if (environment.AUTH_REQUIRED !== "true") {
    violations.push("AUTH_REQUIRED must exactly equal true");
  }

  if (environment.AUTH_DEV_AUTHENTICATOR_ENABLED === "true") {
    const apiToken = normalized(environment.AUTH_DEV_ACCESS_TOKEN);
    const browserToken = normalized(environment.NEXT_PUBLIC_CONTROL_API_ACCESS_TOKEN);
    if (apiToken === undefined || apiToken.length < 32) {
      violations.push("AUTH_DEV_ACCESS_TOKEN must contain at least 32 characters");
    }
    if (browserToken === undefined || browserToken.length < 32) {
      violations.push(
        "NEXT_PUBLIC_CONTROL_API_ACCESS_TOKEN must contain at least 32 characters",
      );
    }
    if (apiToken !== undefined && browserToken !== undefined && apiToken !== browserToken) {
      violations.push("the API and browser development tokens must match");
    }
  } else {
    const missingOidc = missingVariables(environment, OIDC_VARIABLES);
    if (missingOidc.length > 0) {
      violations.push(
        `configure development auth or provide OIDC variables: ${missingOidc.join(", ")}`,
      );
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

export function main(environment = process.env) {
  const result = evaluateLocalDevelopmentEnvironment(environment);
  if (!result.ok) {
    console.error("Local development preflight failed:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    console.error(
      "Copy .env.example to .env, configure the listed names, and never commit the resulting file.",
    );
    process.exitCode = 1;
    return result;
  }

  console.log("Local development preflight passed.");
  console.log("Web UI: http://localhost:3000");
  console.log("Control API health: http://localhost:3001/healthz");
  console.log("Preview gateway health: http://localhost:3002/healthz");
  return result;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();

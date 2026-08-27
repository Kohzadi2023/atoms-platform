import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateStagingDeployment } from "./check-staging-deployment.mjs";
import { createStagingDeploymentFixture } from "./staging-deployment-fixture.mjs";

const composeFile = fileURLToPath(
  new URL("../deploy/staging/compose.yaml", import.meta.url),
);

function parseArguments(arguments_) {
  const normalizedArguments = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (normalizedArguments.length === 0) return undefined;
  const options = {};
  for (let index = 0; index < normalizedArguments.length; index += 1) {
    const argument = normalizedArguments[index];
    if (argument === "--env-file") {
      options.environmentFile = readOptionValue(normalizedArguments, index, argument);
      index += 1;
    } else if (argument === "--secrets-dir") {
      options.secretsDirectory = readOptionValue(normalizedArguments, index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown staging Compose validation argument: ${argument}`);
    }
  }
  if (options.environmentFile === undefined || options.secretsDirectory === undefined) {
    throw new Error("--env-file and --secrets-dir must be provided together");
  }
  return {
    environmentFile: resolve(options.environmentFile),
    secretsDirectory: resolve(options.secretsDirectory),
  };
}

function readOptionValue(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a path`);
  }
  return value;
}

async function main(arguments_ = process.argv.slice(2)) {
  let requestedDeployment;
  try {
    requestedDeployment = parseArguments(arguments_);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid arguments");
    process.exitCode = 1;
    return;
  }

  const fixture =
    requestedDeployment === undefined
      ? await createStagingDeploymentFixture()
      : {
          ...requestedDeployment,
          async cleanup() {},
        };
  const composeArguments = [
    "compose",
    "--env-file",
    fixture.environmentFile,
    "-f",
    composeFile,
  ];
  const composeEnvironment = {
    ...process.env,
    COMPOSE_PROJECT_NAME: `atoms-staging-validation-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  };
  let dockerAvailable = true;

  try {
    const preflight = await validateStagingDeployment({
      environmentFile: fixture.environmentFile,
      secretsDirectory: fixture.secretsDirectory,
    });
    if (!preflight.ok) {
      console.error("The staging deployment contract failed preflight.");
      process.exitCode = 1;
      return;
    }

    const composeResult = spawnSync(
      "docker",
      [...composeArguments, "config", "--quiet"],
      { encoding: "utf8", env: composeEnvironment },
    );
    if (composeResult.error?.code === "ENOENT") {
      dockerAvailable = false;
      console.error("Docker Compose is required to validate the staging manifest.");
      process.exitCode = 1;
      return;
    }
    if (composeResult.status !== 0) {
      console.error("Docker Compose rejected the staging manifest.");
      const diagnostics = composeResult.stderr?.trim() ?? "";
      if (diagnostics.length > 0) console.error(diagnostics);
      process.exitCode = 1;
      return;
    }

    const caddyResult = spawnSync(
      "docker",
      [
        ...composeArguments,
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "reverse-proxy",
        "caddy",
        "validate",
        "--config",
        "/etc/caddy/Caddyfile",
        "--adapter",
        "caddyfile",
      ],
      { encoding: "utf8", env: composeEnvironment },
    );
    if (caddyResult.status !== 0) {
      console.error("Caddy rejected the staging ingress configuration.");
      const diagnostics = caddyResult.stderr?.trim() ?? "";
      if (diagnostics.length > 0) console.error(diagnostics);
      process.exitCode = 1;
      return;
    }
    console.log("Staging Docker Compose and Caddy configurations are valid.");
  } finally {
    if (dockerAvailable) {
      const cleanupResult = spawnSync(
        "docker",
        [...composeArguments, "down", "--volumes", "--remove-orphans"],
        { encoding: "utf8", env: composeEnvironment },
      );
      if (cleanupResult.status !== 0 && process.exitCode !== 1) {
        console.error("The isolated staging validation project could not be removed.");
        process.exitCode = 1;
      }
    }
    await fixture.cleanup();
  }
}

await main();

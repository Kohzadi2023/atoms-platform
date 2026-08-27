import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "dotenv";

import { validateStagingDeployment } from "./check-staging-deployment.mjs";
import {
  PERSISTENT_SERVICES,
  PERSISTENT_VOLUME_ROLES,
  persistentVolumeLabels,
  persistentVolumeName,
  validatePersistentVolumeLabels,
} from "./staging-persistence-contract.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const composeFile = fileURLToPath(
  new URL("../deploy/staging/compose.yaml", import.meta.url),
);
const migrationsDirectory = fileURLToPath(
  new URL("../packages/db/prisma/migrations/", import.meta.url),
);

export const STAGING_PERSISTENCE_CONFIRMATION =
  "BOOTSTRAP_ATOMS_STAGING_PERSISTENCE";

const defaultDependencies = {
  validateDeployment: validateStagingDeployment,
  readPublicEnvironment: async (path) => parse(await readFile(path, "utf8")),
  getRepositoryState,
  listMigrationNames,
  prepareEvidenceOutput,
  runProcess,
  writeEvidence,
  now: () => new Date(),
  log: (message) => console.log(message),
};

export function parseBootstrapArguments(arguments_) {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const optionNames = {
    "--env-file": "environmentFile",
    "--secrets-dir": "secretsDirectory",
    "--evidence-out": "evidenceOutput",
    "--change-ticket": "changeTicket",
    "--confirmation": "confirmation",
  };
  const options = {};
  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    const optionName = optionNames[argument];
    if (optionName === undefined) {
      throw new Error(`Unknown staging persistence argument: ${argument}`);
    }
    if (options[optionName] !== undefined) {
      throw new Error(`Staging persistence option is duplicated: ${argument}`);
    }
    const value = readOptionValue(normalized, index, argument);
    options[optionName] = value;
    index += 1;
  }

  for (const name of [
    "environmentFile",
    "secretsDirectory",
    "evidenceOutput",
    "changeTicket",
    "confirmation",
  ]) {
    if (options[name] === undefined) {
      throw new Error(`Missing required staging persistence option: ${name}`);
    }
  }
  for (const name of ["environmentFile", "secretsDirectory", "evidenceOutput"]) {
    if (!isAbsolute(options[name])) {
      throw new Error(`${name} must be an absolute path`);
    }
    options[name] = resolve(options[name]);
  }
  if (options.confirmation !== STAGING_PERSISTENCE_CONFIRMATION) {
    throw new Error(
      `--confirmation must equal ${STAGING_PERSISTENCE_CONFIRMATION}`,
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/u.test(options.changeTicket)) {
    throw new Error("--change-ticket must be a normalized audit identifier");
  }
  if (!options.evidenceOutput.endsWith(".json")) {
    throw new Error("--evidence-out must name a JSON file");
  }
  return options;
}

export async function bootstrapStagingPersistence(options, dependencies = {}) {
  if (options.confirmation !== STAGING_PERSISTENCE_CONFIRMATION) {
    throw new Error(
      `--confirmation must equal ${STAGING_PERSISTENCE_CONFIRMATION}`,
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/u.test(options.changeTicket ?? "")) {
    throw new Error("--change-ticket must be a normalized audit identifier");
  }
  const deps = { ...defaultDependencies, ...dependencies };
  const evidenceOutput = await deps.prepareEvidenceOutput(
    options.evidenceOutput,
    options.secretsDirectory,
  );
  const preflight = await deps.validateDeployment({
    environmentFile: options.environmentFile,
    secretsDirectory: options.secretsDirectory,
  });
  if (!preflight.ok) {
    throw new Error(
      `Staging deployment preflight failed:\n${preflight.violations
        .map((violation) => `- ${violation}`)
        .join("\n")}`,
    );
  }

  const publicEnvironment = await deps.readPublicEnvironment(
    options.environmentFile,
  );
  const projectName = publicEnvironment.COMPOSE_PROJECT_NAME;
  const imageRevision = publicEnvironment.ATOMS_IMAGE_TAG;
  const repositoryState = await deps.getRepositoryState();
  if (repositoryState.dirty) {
    throw new Error("The staging bootstrap requires a clean Git checkout");
  }
  if (repositoryState.revision !== imageRevision) {
    throw new Error(
      "ATOMS_IMAGE_TAG must exactly match the checked-out Git revision",
    );
  }

  const migrationNames = await deps.listMigrationNames();
  if (migrationNames.length === 0) {
    throw new Error("No Prisma migrations were found in the checked-out revision");
  }

  const composeArguments = [
    "compose",
    "--env-file",
    options.environmentFile,
    "-f",
    composeFile,
  ];
  const runDocker = async (arguments_, label, allowFailure = false) => {
    deps.log(label);
    return deps.runProcess("docker", arguments_, { allowFailure, label });
  };

  await runDocker(["info", "--format", "{{json .ServerVersion}}"], "Checking Docker daemon");
  await runDocker(
    [...composeArguments, "config", "--quiet"],
    "Validating the rendered staging manifest",
  );
  await runDocker(
    [
      ...composeArguments,
      "pull",
      "postgres",
      "redis",
      "minio",
      "minio-init",
      "clamav",
    ],
    "Pulling pinned persistence images",
  );
  await runDocker(
    [...composeArguments, "build", "--pull", "migrate"],
    "Building the revision-pinned migration image",
  );

  const volumes = [];
  for (const role of PERSISTENT_VOLUME_ROLES) {
    const name = persistentVolumeName(projectName, role);
    const initialInspection = await runDocker(
      ["volume", "inspect", "--format", "{{json .Labels}}", name],
      `Inspecting ${role} persistence volume`,
      true,
    );
    let disposition = "reused";
    if (initialInspection.status !== 0) {
      const labels = persistentVolumeLabels(projectName, role);
      const labelArguments = Object.entries(labels)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([label, value]) => ["--label", `${label}=${value}`]);
      await runDocker(
        ["volume", "create", ...labelArguments, name],
        `Creating ${role} persistence volume`,
      );
      disposition = "created";
    }

    const inspection = await runDocker(
      ["volume", "inspect", "--format", "{{json .Labels}}", name],
      `Verifying ${role} persistence volume ownership`,
    );
    const labels = parseVolumeLabels(inspection.stdout, role);
    const mismatches = validatePersistentVolumeLabels(projectName, role, labels);
    if (mismatches.length > 0) {
      throw new Error(
        `${role} persistence volume has invalid ownership labels: ${mismatches.join(", ")}`,
      );
    }
    volumes.push({ name, role, disposition });
  }

  await runDocker(
    [
      ...composeArguments,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "600",
      ...PERSISTENT_SERVICES,
    ],
    "Starting persistent staging dependencies",
  );
  await runDocker(
    [...composeArguments, "run", "--rm", "--no-deps", "-T", "minio-init"],
    "Initializing the private attachment bucket",
  );
  await runDocker(
    [...composeArguments, "run", "--rm", "--no-deps", "-T", "migrate"],
    "Applying Prisma migrations",
  );
  await runDocker(
    [
      ...composeArguments,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "migrate",
      "node",
      "--env-file=/run/secrets/migration_environment",
      "node_modules/prisma/build/index.js",
      "--config",
      "./prisma.config.ts",
      "migrate",
      "status",
    ],
    "Confirming the complete Prisma migration history",
  );
  const serviceResult = await runDocker(
    [
      ...composeArguments,
      "ps",
      "--status",
      "running",
      "--services",
      ...PERSISTENT_SERVICES,
    ],
    "Confirming persistent service health",
  );
  const runningServices = new Set(
    serviceResult.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const missingServices = PERSISTENT_SERVICES.filter(
    (service) => !runningServices.has(service),
  );
  if (missingServices.length > 0) {
    throw new Error(
      `Persistent services are not all running: ${missingServices.join(", ")}`,
    );
  }

  const evidence = {
    version: "atoms-staging-persistence-bootstrap.v1",
    changeTicket: options.changeTicket,
    recordedAt: deps.now().toISOString(),
    commitSha: imageRevision,
    composeProjectName: projectName,
    migrations: migrationNames,
    persistentServices: [...PERSISTENT_SERVICES],
    volumes,
    gates: [
      { name: "secret_safe_preflight", status: "PASSED" },
      { name: "clean_revision_pin", status: "PASSED" },
      { name: "external_volume_ownership", status: "PASSED" },
      { name: "persistent_service_health", status: "PASSED" },
      { name: "private_attachment_bucket", status: "PASSED" },
      { name: "prisma_migrate_deploy", status: "PASSED" },
      { name: "prisma_migrate_status", status: "PASSED" },
    ],
  };
  await deps.writeEvidence(evidenceOutput, evidence);
  deps.log(`Wrote redacted staging persistence evidence to ${evidenceOutput}`);
  return evidence;
}

function readOptionValue(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseVolumeLabels(output, role) {
  try {
    const parsed = JSON.parse(output.trim());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid labels");
    }
    return parsed;
  } catch {
    throw new Error(`${role} persistence volume labels could not be verified`);
  }
}

async function getRepositoryState() {
  const revision = runProcess("git", ["rev-parse", "HEAD"], {
    label: "reading the checked-out revision",
  }).stdout.trim();
  const status = runProcess("git", ["status", "--porcelain=v1"], {
    label: "checking the Git worktree",
  }).stdout;
  return { revision, dirty: status.trim().length > 0 };
}

async function listMigrationNames() {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function runProcess(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(`${executable} is required for the staging bootstrap`);
  }
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    throw new Error(`Command failed while ${options.label ?? "bootstrapping staging"}`);
  }
  return { status, stdout: result.stdout ?? "" };
}

async function prepareEvidenceOutput(path, secretsDirectory) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const [canonicalParent, canonicalRepository, canonicalSecrets] = await Promise.all([
    realpath(parent),
    realpath(repositoryRoot),
    realpath(secretsDirectory),
  ]);
  if (
    isInside(canonicalRepository, canonicalParent) ||
    isInside(canonicalSecrets, canonicalParent)
  ) {
    throw new Error(
      "--evidence-out must be outside both the repository and secrets directory",
    );
  }
  const canonicalOutput = join(canonicalParent, basename(path));
  try {
    await lstat(canonicalOutput);
    throw new Error("The staging persistence evidence file already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return canonicalOutput;
}

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

async function writeEvidence(path, evidence) {
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function main() {
  try {
    const options = parseBootstrapArguments(process.argv.slice(2));
    await bootstrapStagingPersistence(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Staging bootstrap failed");
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}

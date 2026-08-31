import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, unlinkSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "dotenv";

import { validateStagingDeployment } from "./check-staging-deployment.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const composeFile = fileURLToPath(
  new URL("../deploy/staging/compose.yaml", import.meta.url),
);

export const RESTART_CONFIRMATION = "RESTART_ATOMS_STAGING_SERVICES";
export const BACKUP_RESTORE_CONFIRMATION =
  "BACKUP_AND_RESTORE_ATOMS_STAGING_IN_ISOLATED_RESOURCES";
export const ROLLBACK_CONFIRMATION =
  "ROLLBACK_AND_RETURN_ATOMS_STAGING_APPLICATIONS";

export const APPLICATION_SERVICES = Object.freeze([
  "control-api",
  "orchestrator-worker",
  "preview-gateway",
  "web",
]);

const STOPPABLE_SERVICES = Object.freeze([
  "reverse-proxy",
  "web",
  "preview-gateway",
  "control-api",
  "orchestrator-worker",
]);

const PERSISTENT_SERVICES = Object.freeze([
  "postgres",
  "redis",
  "minio",
  "clamav",
]);

const RUNTIME_SERVICES = Object.freeze([
  "reverse-proxy",
  ...PERSISTENT_SERVICES,
  ...APPLICATION_SERVICES,
]);

const REVISION_LABELED_SERVICES = Object.freeze([
  "reverse-proxy",
  ...APPLICATION_SERVICES,
]);

const POSTGRES_IMAGE = "postgres:17-alpine";
const REDIS_IMAGE = "redis:8-alpine";
const MINIO_IMAGE = "minio/minio:RELEASE.2025-09-07T16-13-09Z";
const MINIO_CLIENT_IMAGE = "minio/mc:RELEASE.2025-08-13T08-35-41Z";
const RECOVERY_SCHEMA = "atoms.staging.recovery-rehearsal.v1";
const SMOKE_SCHEMA = "atoms.staging.authenticated-smoke.v1";
const BOOTSTRAP_SCHEMA = "atoms-staging-persistence-bootstrap.v1";
const CHANGE_TICKET_PATTERN = /^[A-Z][A-Z0-9-]{1,63}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const CI_RUN_PATTERN = /^[1-9][0-9]{0,18}$/u;
const REQUIRED_BOOTSTRAP_GATES = Object.freeze([
  "secret_safe_preflight",
  "clean_revision_pin",
  "external_volume_ownership",
  "persistent_service_health",
  "private_attachment_bucket",
  "prisma_migrate_deploy",
  "prisma_migrate_status",
]);
const REQUIRED_SMOKE_CHECKS = Object.freeze([
  "web_https_and_csp",
  "control_api_health",
  "cors_and_auth_boundary",
  "two_identity_workspace_isolation",
  "attachment_upload_scan_download",
  "sse_reconnect_and_scoped_approvals",
  "seven_agent_artifacts",
  "signed_preview_security",
  "run_completed",
]);
const POSTGRES_STATE_SQL = `SELECT json_build_object(
  'migrations', (SELECT count(*)::int FROM "_prisma_migrations" WHERE finished_at IS NOT NULL),
  'runs', (SELECT count(*)::int FROM agent_runs),
  'activeRuns', (
    SELECT count(*)::int
    FROM agent_runs
    WHERE status::text NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
  )
)::text;`;

const defaultDependencies = {
  validateDeployment: validateStagingDeployment,
  readPublicEnvironment: async (path) => parse(await readFile(path, "utf8")),
  getRepositoryState,
  preparePaths: prepareRecoveryPaths,
  readPrerequisites: readPrerequisiteEvidence,
  createBackupDirectory,
  ensureCurrentStack,
  createBackups,
  restoreBackupsInIsolation,
  rehearseRestart,
  rehearseRollbackAndReturn,
  writeEvidence: writeRedactedEvidence,
  runProcess,
  fetch: globalThis.fetch,
  delay: (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  randomUUID,
  now: () => new Date(),
  log: (message) => console.log(message),
};

export function parseRecoveryArguments(arguments_) {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const optionNames = new Map([
    ["--env-file", "environmentFile"],
    ["--secrets-dir", "secretsDirectory"],
    ["--bootstrap-evidence", "bootstrapEvidence"],
    ["--smoke-evidence", "smokeEvidence"],
    ["--backup-dir", "backupDirectory"],
    ["--evidence-out", "evidenceOutput"],
    ["--previous-revision", "previousRevision"],
    ["--ci-run-id", "ciRunId"],
    ["--change-ticket", "changeTicket"],
    ["--restart-confirmation", "restartConfirmation"],
    ["--backup-restore-confirmation", "backupRestoreConfirmation"],
    ["--rollback-confirmation", "rollbackConfirmation"],
  ]);
  const options = {};
  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    const property = optionNames.get(argument);
    if (property === undefined) {
      throw new Error(`Unknown staging recovery argument: ${argument}`);
    }
    if (options[property] !== undefined) {
      throw new Error(`${argument} may be supplied only once`);
    }
    const value = normalized[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    options[property] = value;
    index += 1;
  }

  const validation = validateRecoveryCommandOptions(options);
  if (validation.violations.length > 0) {
    throw new Error(
      `Staging recovery command is invalid:\n${validation.violations
        .map((violation) => `- ${violation}`)
        .join("\n")}`,
    );
  }
  return Object.fromEntries(
    Object.entries(options).map(([name, value]) => [
      name,
      name.endsWith("Directory") ||
      name.endsWith("Evidence") ||
      name.endsWith("Output") ||
      name === "environmentFile"
        ? resolve(value)
        : value,
    ]),
  );
}

export function validateRecoveryCommandOptions(options) {
  const violations = [];
  const required = [
    "environmentFile",
    "secretsDirectory",
    "bootstrapEvidence",
    "smokeEvidence",
    "backupDirectory",
    "evidenceOutput",
    "previousRevision",
    "ciRunId",
    "changeTicket",
    "restartConfirmation",
    "backupRestoreConfirmation",
    "rollbackConfirmation",
  ];
  for (const name of required) {
    if (typeof options[name] !== "string" || options[name].length === 0) {
      violations.push(`Missing required staging recovery option: ${name}`);
    }
  }

  for (const [label, name] of [
    ["--env-file", "environmentFile"],
    ["--secrets-dir", "secretsDirectory"],
    ["--bootstrap-evidence", "bootstrapEvidence"],
    ["--smoke-evidence", "smokeEvidence"],
    ["--backup-dir", "backupDirectory"],
    ["--evidence-out", "evidenceOutput"],
  ]) {
    const value = options[name];
    if (typeof value === "string" && !isAbsolute(value)) {
      violations.push(`${label} must use an absolute path`);
    }
  }

  if (
    typeof options.backupDirectory === "string" &&
    /[:,\r\n]/u.test(options.backupDirectory)
  ) {
    violations.push("--backup-dir contains a character unsafe for a Docker bind mount");
  }
  if (
    typeof options.evidenceOutput === "string" &&
    !options.evidenceOutput.endsWith(".json")
  ) {
    violations.push("--evidence-out must name a JSON file");
  }
  if (
    typeof options.bootstrapEvidence === "string" &&
    !options.bootstrapEvidence.endsWith(".json")
  ) {
    violations.push("--bootstrap-evidence must name a JSON file");
  }
  if (
    typeof options.smokeEvidence === "string" &&
    !options.smokeEvidence.endsWith(".json")
  ) {
    violations.push("--smoke-evidence must name a JSON file");
  }
  if (!REVISION_PATTERN.test(options.previousRevision ?? "")) {
    violations.push("--previous-revision must be a full lowercase Git SHA");
  }
  if (!CI_RUN_PATTERN.test(options.ciRunId ?? "")) {
    violations.push("--ci-run-id must be a positive numeric GitHub Actions run ID");
  }
  if (!CHANGE_TICKET_PATTERN.test(options.changeTicket ?? "")) {
    violations.push("--change-ticket must be a normalized audit identifier");
  }
  if (options.restartConfirmation !== RESTART_CONFIRMATION) {
    violations.push(`--restart-confirmation must equal ${RESTART_CONFIRMATION}`);
  }
  if (options.backupRestoreConfirmation !== BACKUP_RESTORE_CONFIRMATION) {
    violations.push(
      `--backup-restore-confirmation must equal ${BACKUP_RESTORE_CONFIRMATION}`,
    );
  }
  if (options.rollbackConfirmation !== ROLLBACK_CONFIRMATION) {
    violations.push(`--rollback-confirmation must equal ${ROLLBACK_CONFIRMATION}`);
  }

  if (required.every((name) => typeof options[name] === "string")) {
    const resolved = Object.fromEntries(
      [
        "environmentFile",
        "secretsDirectory",
        "bootstrapEvidence",
        "smokeEvidence",
        "backupDirectory",
        "evidenceOutput",
      ].map((name) => [name, resolve(options[name])]),
    );
    for (const [label, path] of [
      ["--bootstrap-evidence", resolved.bootstrapEvidence],
      ["--smoke-evidence", resolved.smokeEvidence],
      ["--backup-dir", resolved.backupDirectory],
      ["--evidence-out", resolved.evidenceOutput],
    ]) {
      if (isInside(path, repositoryRoot)) {
        violations.push(`${label} must be outside the repository`);
      }
      if (isInside(path, resolved.secretsDirectory)) {
        violations.push(`${label} must be outside the secrets directory`);
      }
    }
    if (
      isInside(resolved.evidenceOutput, resolved.backupDirectory) ||
      isInside(resolved.bootstrapEvidence, resolved.backupDirectory) ||
      isInside(resolved.smokeEvidence, resolved.backupDirectory)
    ) {
      violations.push("evidence files must not be stored inside --backup-dir");
    }
  }
  return { violations };
}

export async function rehearseStagingRecovery(options, dependencies = {}) {
  const commandValidation = validateRecoveryCommandOptions(options);
  if (commandValidation.violations.length > 0) {
    throw new Error(
      `Staging recovery command is invalid:\n${commandValidation.violations
        .map((violation) => `- ${violation}`)
        .join("\n")}`,
    );
  }
  const deps = { ...defaultDependencies, ...dependencies };
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
  const currentRevision = publicEnvironment.ATOMS_IMAGE_TAG;
  const repositoryState = await deps.getRepositoryState(options.previousRevision);
  if (repositoryState.dirty) {
    throw new Error("Staging recovery rehearsal requires a clean Git checkout");
  }
  if (repositoryState.revision !== currentRevision) {
    throw new Error("ATOMS_IMAGE_TAG must exactly match the checked-out Git revision");
  }
  if (!repositoryState.previousIsAncestor) {
    throw new Error("--previous-revision must be an available ancestor of ATOMS_IMAGE_TAG");
  }
  if (options.previousRevision === currentRevision) {
    throw new Error("--previous-revision must differ from ATOMS_IMAGE_TAG");
  }

  const paths = await deps.preparePaths(options);
  const prerequisites = await deps.readPrerequisites({
    bootstrapEvidence: paths.bootstrapEvidence,
    smokeEvidence: paths.smokeEvidence,
    currentRevision,
    changeTicket: options.changeTicket,
  });
  await deps.createBackupDirectory(paths.backupDirectory);

  const context = {
    options,
    paths,
    prerequisites,
    publicEnvironment,
    currentRevision,
    previousRevision: options.previousRevision,
    composeArguments: [
      "compose",
      "--env-file",
      options.environmentFile,
      "-f",
      composeFile,
    ],
    runProcess: deps.runProcess,
    fetch: deps.fetch,
    delay: deps.delay,
    randomUUID: deps.randomUUID,
    log: deps.log,
  };

  await deps.ensureCurrentStack(context);
  const backup = await deps.createBackups(context);
  const restore = await deps.restoreBackupsInIsolation(context, backup);
  const restart = await deps.rehearseRestart(context);
  const rollback = await deps.rehearseRollbackAndReturn(context);

  const evidence = {
    schemaVersion: RECOVERY_SCHEMA,
    outcome: "passed",
    completedAt: deps.now().toISOString(),
    changeTicket: options.changeTicket,
    currentRevision,
    previousRevision: options.previousRevision,
    ciRunId: options.ciRunId,
    prerequisites,
    backupRestore: {
      postgres: restore.postgres,
      redis: restore.redis,
      objectStorage: restore.objectStorage,
      isolatedResourcesRemoved: restore.isolatedResourcesRemoved,
      protectedBackupRetained: true,
    },
    restart,
    rollback,
    gates: [
      "secret_safe_preflight",
      "clean_revision_pin",
      "prior_bootstrap_evidence",
      "prior_authenticated_smoke_evidence",
      "current_stack_revision",
      "protected_backup_created",
      "isolated_restore_verified",
      "durable_restart_verified",
      "previous_revision_health_verified",
      "current_revision_restored",
      "temporary_resources_removed",
    ].map((name) => ({ name, status: "PASSED" })),
  };
  assertRedactedRecoveryEvidence(evidence);
  await deps.writeEvidence(paths.evidenceOutput, evidence);
  deps.log(`Wrote redacted staging recovery evidence to ${paths.evidenceOutput}`);
  return evidence;
}

async function prepareRecoveryPaths(options) {
  const paths = {
    environmentFile: resolve(options.environmentFile),
    secretsDirectory: resolve(options.secretsDirectory),
    bootstrapEvidence: resolve(options.bootstrapEvidence),
    smokeEvidence: resolve(options.smokeEvidence),
    backupDirectory: resolve(options.backupDirectory),
    evidenceOutput: resolve(options.evidenceOutput),
  };
  const parents = new Set([
    dirname(paths.backupDirectory),
    dirname(paths.evidenceOutput),
  ]);
  for (const parent of parents) {
    const canonical = await realpath(parent);
    if (canonical !== resolve(parent)) {
      throw new Error("recovery output parent directories must not traverse symlinks");
    }
  }
  const canonicalSecrets = await realpath(paths.secretsDirectory);
  const canonicalRepository = await realpath(repositoryRoot);
  for (const [label, path] of [
    ["bootstrap evidence", paths.bootstrapEvidence],
    ["smoke evidence", paths.smokeEvidence],
    ["backup directory", paths.backupDirectory],
    ["recovery evidence", paths.evidenceOutput],
  ]) {
    if (isInside(path, canonicalSecrets) || isInside(path, canonicalRepository)) {
      throw new Error(`${label} must remain outside secrets and source control`);
    }
  }
  await requireMissing(paths.backupDirectory, "backup directory");
  await requireMissing(paths.evidenceOutput, "recovery evidence output");
  return paths;
}

async function readPrerequisiteEvidence(options) {
  const bootstrap = await readEvidenceFile(options.bootstrapEvidence);
  const bootstrapGates = new Set(
    Array.isArray(bootstrap.gates)
      ? bootstrap.gates
          .filter((gate) => gate?.status === "PASSED")
          .map((gate) => gate?.name)
      : [],
  );
  if (
    bootstrap.version !== BOOTSTRAP_SCHEMA ||
    bootstrap.commitSha !== options.currentRevision ||
    bootstrap.changeTicket !== options.changeTicket ||
    REQUIRED_BOOTSTRAP_GATES.some((gate) => !bootstrapGates.has(gate))
  ) {
    throw new Error("persistence bootstrap evidence does not pass for ATOMS_IMAGE_TAG");
  }
  const smoke = await readEvidenceFile(options.smokeEvidence);
  const smokeChecks = new Set(Array.isArray(smoke.checks) ? smoke.checks : []);
  if (
    smoke.schemaVersion !== SMOKE_SCHEMA ||
    smoke.outcome !== "passed" ||
    smoke.revision !== options.currentRevision ||
    smoke.changeTicket !== options.changeTicket ||
    REQUIRED_SMOKE_CHECKS.some((check) => !smokeChecks.has(check))
  ) {
    throw new Error("authenticated smoke evidence does not pass for ATOMS_IMAGE_TAG");
  }
  return {
    persistenceBootstrap: { schemaVersion: BOOTSTRAP_SCHEMA, verified: true },
    authenticatedSmoke: { schemaVersion: SMOKE_SCHEMA, verified: true },
  };
}

async function readEvidenceFile(path) {
  const canonicalPath = await realpath(path);
  if (canonicalPath !== resolve(path)) {
    throw new Error("prerequisite evidence path must not traverse symlinks");
  }
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o7777) !== 0o600
  ) {
    throw new Error("prerequisite evidence must be a regular mode-0600 file");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("prerequisite evidence is not valid JSON");
  }
}

async function createBackupDirectory(path) {
  await mkdir(path, { mode: 0o700 });
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o7777) !== 0o700
  ) {
    throw new Error("backup directory must be a real mode-0700 directory");
  }
}

async function ensureCurrentStack(context) {
  await runDocker(context, ["info", "--format", "{{json .ServerVersion}}"], "Checking Docker daemon");
  await runCompose(context, ["config", "--quiet"], "Validating the rendered staging manifest");
  const running = await runCompose(
    context,
    ["ps", "--status", "running", "--services"],
    "Confirming the complete staging stack is running",
  );
  const runningServices = new Set(lines(running.stdout));
  const missing = RUNTIME_SERVICES.filter((service) => !runningServices.has(service));
  if (missing.length > 0) {
    throw new Error(`Staging services are not all running: ${missing.join(", ")}`);
  }
  await verifyApplicationRevision(context, context.currentRevision);
  await verifyExternalHealth(context);
}

export async function createBackups(context) {
  let stopAttempted = false;
  try {
    stopAttempted = true;
    await runCompose(
      context,
      ["stop", "--timeout", "60", ...STOPPABLE_SERVICES],
      "Stopping application writers for a consistent protected backup",
    );
    return await createProtectedBackups(context);
  } finally {
    if (stopAttempted) {
      try {
        await rollForwardCurrentStack(context);
      } catch {
        throw new Error(
          "backup operation ended and the current stack could not be recovered",
        );
      }
    }
  }
}

async function createProtectedBackups(context) {
  context.log("Capturing the pre-rehearsal durability witness");
  const state = await captureDurabilityState(context);
  assertRecoveryWitness(state);

  const postgresPath = join(context.paths.backupDirectory, "postgres.dump");
  const redisPath = join(context.paths.backupDirectory, "redis.rdb");
  const objectStoragePath = join(context.paths.backupDirectory, "object-storage");
  await mkdir(objectStoragePath, { mode: 0o700 });

  await runCompose(
    context,
    [
      "exec",
      "-T",
      "postgres",
      "/bin/sh",
      "-ec",
      'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom --compress=6 --no-owner --no-acl',
    ],
    "Creating the protected PostgreSQL backup",
    { stdoutFile: postgresPath },
  );
  await runCompose(
    context,
    [
      "exec",
      "-T",
      "redis",
      "/bin/sh",
      "-ec",
      'REDISCLI_AUTH="$(cat /run/secrets/redis_password)" redis-cli SAVE >/dev/null',
    ],
    "Creating a consistent Redis snapshot",
  );
  await runCompose(
    context,
    ["cp", "redis:/data/dump.rdb", redisPath],
    "Copying the protected Redis snapshot",
  );
  await chmod(redisPath, 0o600);

  const minioBackupScript = [
    'root_user="$(cat /run/secrets/minio_root_user)"',
    'root_password="$(cat /run/secrets/minio_root_password)"',
    'mc alias set staging http://minio:9000 "$root_user" "$root_password" >/dev/null',
    'mc mirror --quiet "staging/$1" /backup',
  ].join("\n");
  await runCompose(
    context,
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "-v",
      `${objectStoragePath}:/backup`,
      "--entrypoint",
      "/bin/sh",
      "minio-init",
      "-ec",
      minioBackupScript,
      "sh",
      context.publicEnvironment.ATOMS_S3_BUCKET,
    ],
    "Creating the protected object-storage backup",
  );
  await hardenDirectoryTree(objectStoragePath);

  const [postgresMetadata, redisMetadata, objectStorage] = await Promise.all([
    stat(postgresPath),
    stat(redisPath),
    directoryMetrics(objectStoragePath),
  ]);
  if (
    postgresMetadata.size === 0 ||
    redisMetadata.size === 0 ||
    objectStorage.files !== state.objectStorage.objects ||
    objectStorage.bytes !== state.objectStorage.bytes
  ) {
    throw new Error("protected backup artifacts do not match the live durability witness");
  }
  return {
    state,
    postgresPath,
    redisPath,
    objectStoragePath,
  };
}

export async function restoreBackupsInIsolation(context, backup) {
  const suffix = context.randomUUID().replaceAll("-", "").slice(0, 12).toLowerCase();
  const prefix = `atoms-recovery-${suffix}`;
  const resources = {
    network: `${prefix}-network`,
    postgresVolume: `${prefix}-postgres-data`,
    redisVolume: `${prefix}-redis-data`,
    minioVolume: `${prefix}-minio-data`,
    postgresContainer: `${prefix}-postgres`,
    redisContainer: `${prefix}-redis`,
    minioContainer: `${prefix}-minio`,
  };
  assertIsolatedResourceNames(resources);
  const created = { network: false, volumes: [], containers: [] };
  let operationError;
  let result;
  try {
    const labels = [
      "--label",
      "com.atoms.environment=staging",
      "--label",
      "com.atoms.purpose=recovery-rehearsal",
      "--label",
      `com.atoms.change-ticket=${context.options.changeTicket}`,
    ];
    await runDocker(
      context,
      ["network", "create", "--internal", ...labels, resources.network],
      "Creating the isolated recovery network",
    );
    created.network = true;
    for (const volume of [
      resources.postgresVolume,
      resources.redisVolume,
      resources.minioVolume,
    ]) {
      await runDocker(
        context,
        ["volume", "create", ...labels, volume],
        "Creating an isolated recovery volume",
      );
      created.volumes.push(volume);
    }

    await runDocker(
      context,
      [
        "run",
        "-d",
        "--name",
        resources.postgresContainer,
        "--network",
        resources.network,
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "-v",
        `${resources.postgresVolume}:/var/lib/postgresql/data`,
        POSTGRES_IMAGE,
      ],
      "Starting the isolated PostgreSQL restore target",
    );
    created.containers.push(resources.postgresContainer);
    await waitForCommand(context, [
      "exec",
      resources.postgresContainer,
      "pg_isready",
      "-U",
      "postgres",
    ], "Waiting for isolated PostgreSQL");
    await runDocker(
      context,
      ["exec", resources.postgresContainer, "createdb", "-U", "postgres", "atoms_restore"],
      "Creating the isolated PostgreSQL restore database",
    );
    await runDocker(
      context,
      [
        "exec",
        "-i",
        resources.postgresContainer,
        "pg_restore",
        "-U",
        "postgres",
        "-d",
        "atoms_restore",
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
      ],
      "Restoring PostgreSQL into the isolated target",
      { stdinFile: backup.postgresPath },
    );
    const restoredPostgres = await captureIsolatedPostgresState(
      context,
      resources.postgresContainer,
    );
    assertEqualState("PostgreSQL restore", backup.state.postgres, restoredPostgres);

    await runDocker(
      context,
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${resources.redisVolume}:/data`,
        "-v",
        `${context.paths.backupDirectory}:/backup:ro`,
        REDIS_IMAGE,
        "/bin/sh",
        "-ec",
        "cp /backup/redis.rdb /data/dump.rdb && chown redis:redis /data/dump.rdb && chmod 0600 /data/dump.rdb",
      ],
      "Seeding the isolated Redis restore volume",
    );
    await runDocker(
      context,
      [
        "run",
        "-d",
        "--name",
        resources.redisContainer,
        "--network",
        resources.network,
        "-v",
        `${resources.redisVolume}:/data`,
        REDIS_IMAGE,
        "redis-server",
        "--appendonly",
        "no",
        "--save",
        "",
      ],
      "Starting the isolated Redis restore target",
    );
    created.containers.push(resources.redisContainer);
    await waitForCommand(
      context,
      ["exec", resources.redisContainer, "redis-cli", "ping"],
      "Waiting for isolated Redis",
    );
    const restoredRedis = await captureIsolatedRedisState(
      context,
      resources.redisContainer,
    );
    assertEqualState("Redis restore", backup.state.redis, restoredRedis);

    const restoreUser = "atomsrecovery";
    const restorePassword = "atoms-recovery-isolated-only-2026";
    await runDocker(
      context,
      [
        "run",
        "-d",
        "--name",
        resources.minioContainer,
        "--network",
        resources.network,
        "-e",
        `MINIO_ROOT_USER=${restoreUser}`,
        "-e",
        `MINIO_ROOT_PASSWORD=${restorePassword}`,
        "-v",
        `${resources.minioVolume}:/data`,
        MINIO_IMAGE,
        "server",
        "/data",
      ],
      "Starting the isolated object-storage restore target",
    );
    created.containers.push(resources.minioContainer);
    await waitForMinio(
      context,
      resources.network,
      resources.minioContainer,
      restoreUser,
      restorePassword,
    );
    const restoreScript = [
      'mc alias set restore "http://$1:9000" "$2" "$3" >/dev/null',
      'mc mb --ignore-existing "restore/$4" >/dev/null',
      'mc mirror --quiet /backup "restore/$4"',
      'mc ls --recursive --json "restore/$4"',
    ].join("\n");
    const minioRestore = await runDocker(
      context,
      [
        "run",
        "--rm",
        "--network",
        resources.network,
        "-v",
        `${backup.objectStoragePath}:/backup:ro`,
        "--entrypoint",
        "/bin/sh",
        MINIO_CLIENT_IMAGE,
        "-ec",
        restoreScript,
        "sh",
        resources.minioContainer,
        restoreUser,
        restorePassword,
        context.publicEnvironment.ATOMS_S3_BUCKET,
      ],
      "Restoring object storage into the isolated target",
    );
    const restoredObjectStorage = parseMinioListing(minioRestore.stdout);
    assertEqualState(
      "object-storage restore",
      backup.state.objectStorage,
      restoredObjectStorage,
    );

    result = {
      postgres: "backup-created-and-isolated-restore-verified",
      redis: "backup-created-and-isolated-restore-verified",
      objectStorage: "backup-created-and-isolated-restore-verified",
      isolatedResourcesRemoved: true,
    };
  } catch (error) {
    operationError = error;
  } finally {
    const cleanupOk = await cleanupIsolatedResources(context, resources, created);
    if (!cleanupOk) {
      throw new Error(
        operationError === undefined
          ? "isolated recovery resources could not be completely removed"
          : "isolated restore failed and temporary resource cleanup was incomplete",
      );
    }
  }
  if (operationError !== undefined) throw operationError;
  return result;
}

export async function rehearseRestart(context) {
  let stopAttempted = false;
  let stackRecovered = false;
  let operationError;
  let result;
  try {
    stopAttempted = true;
    await runCompose(
      context,
      ["stop", "--timeout", "60", ...STOPPABLE_SERVICES],
      "Stopping application services before the durability restart",
    );
    const beforeRestart = await captureDurabilityState(context);
    assertRecoveryWitness(beforeRestart);
    await runCompose(
      context,
      ["restart", "--timeout", "120", ...PERSISTENT_SERVICES],
      "Restarting persistent staging services",
    );
    await runCompose(
      context,
      ["up", "-d", "--wait", "--wait-timeout", "600", ...PERSISTENT_SERVICES],
      "Waiting for persistent services after restart",
    );
    const afterRestart = await captureDurabilityState(context);
    assertEqualState("post-restart durability witness", beforeRestart, afterRestart);
    await rollForwardCurrentStack(context);
    stackRecovered = true;
    result = {
      persistentServicesRestarted: true,
      durableDatabaseStatePreserved: true,
      queuedWorkStatePreserved: true,
      objectStatePreserved: true,
      currentRevisionHealthy: true,
    };
  } catch (error) {
    operationError = error;
  } finally {
    if (stopAttempted && !stackRecovered) {
      try {
        await rollForwardCurrentStack(context);
        stackRecovered = true;
      } catch {
        throw new Error("restart rehearsal failed and the current stack could not be recovered");
      }
    }
  }
  if (operationError !== undefined) throw operationError;
  return result;
}

export async function rehearseRollbackAndReturn(context) {
  for (const service of APPLICATION_SERVICES) {
    await runDocker(
      context,
      ["image", "inspect", `${imageRepository(service)}:${context.previousRevision}`],
      `Confirming the previous ${service} image is retained`,
    );
  }
  let rollbackAttempted = false;
  let previousHealthy = false;
  let operationError;
  try {
    rollbackAttempted = true;
    await runCompose(
      context,
      [
        "up",
        "-d",
        "--no-build",
        "--no-deps",
        "--wait",
        "--wait-timeout",
        "600",
        ...APPLICATION_SERVICES,
      ],
      "Rolling application services back to the retained revision",
      { environment: { ATOMS_IMAGE_TAG: context.previousRevision } },
    );
    await verifyApplicationRevision(
      context,
      context.previousRevision,
      APPLICATION_SERVICES,
    );
    await verifyExternalHealth(context);
    previousHealthy = true;
  } catch (error) {
    operationError = error;
  } finally {
    if (rollbackAttempted) {
      try {
        await rollForwardCurrentStack(context);
      } catch {
        throw new Error("rollback rehearsal could not restore the current application revision");
      }
    }
  }
  if (operationError !== undefined) throw operationError;
  return {
    previousRevisionHealthy: previousHealthy,
    databaseMigrationsReversed: false,
    persistentVolumesChanged: false,
    currentRevisionRestored: true,
    currentRevisionHealthy: true,
  };
}

async function rollForwardCurrentStack(context) {
  await runCompose(
    context,
    ["up", "-d", "--no-build", "--wait", "--wait-timeout", "600"],
    "Restoring the current staging revision",
    { environment: { ATOMS_IMAGE_TAG: context.currentRevision } },
  );
  await verifyApplicationRevision(context, context.currentRevision);
  await verifyExternalHealth(context);
}

async function captureDurabilityState(context) {
  const [postgres, redis, objectStorage] = await Promise.all([
    captureLivePostgresState(context),
    captureLiveRedisState(context),
    captureLiveMinioState(context),
  ]);
  return { postgres, redis, objectStorage };
}

async function captureLivePostgresState(context) {
  const result = await runCompose(
    context,
    [
      "exec",
      "-T",
      "postgres",
      "/bin/sh",
      "-ec",
      'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "$1"',
      "sh",
      POSTGRES_STATE_SQL,
    ],
    "Capturing the PostgreSQL durability witness",
  );
  return parseStateJson(result.stdout, "PostgreSQL durability witness");
}

async function captureIsolatedPostgresState(context, container) {
  const result = await runDocker(
    context,
    [
      "exec",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "atoms_restore",
      "--tuples-only",
      "--no-align",
      "--command",
      POSTGRES_STATE_SQL,
    ],
    "Verifying the isolated PostgreSQL restore",
  );
  return parseStateJson(result.stdout, "isolated PostgreSQL witness");
}

async function captureLiveRedisState(context) {
  const pattern = `${context.publicEnvironment.ATOMS_RUN_QUEUE_PREFIX}:*`;
  const script = [
    'password="$(cat /run/secrets/redis_password)"',
    'db_size="$(REDISCLI_AUTH="$password" redis-cli --raw DBSIZE)"',
    'queue_keys="$(REDISCLI_AUTH="$password" redis-cli --raw --scan --pattern "$1" | wc -l | tr -d " ")"',
    'printf \'{"dbSize":%s,"queueKeys":%s}\\n\' "$db_size" "$queue_keys"',
  ].join("\n");
  const result = await runCompose(
    context,
    ["exec", "-T", "redis", "/bin/sh", "-ec", script, "sh", pattern],
    "Capturing the Redis durability witness",
  );
  return parseStateJson(result.stdout, "Redis durability witness");
}

async function captureIsolatedRedisState(context, container) {
  const pattern = `${context.publicEnvironment.ATOMS_RUN_QUEUE_PREFIX}:*`;
  const script = [
    'db_size="$(redis-cli --raw DBSIZE)"',
    'queue_keys="$(redis-cli --raw --scan --pattern "$1" | wc -l | tr -d " ")"',
    'printf \'{"dbSize":%s,"queueKeys":%s}\\n\' "$db_size" "$queue_keys"',
  ].join("\n");
  const result = await runDocker(
    context,
    ["exec", container, "/bin/sh", "-ec", script, "sh", pattern],
    "Verifying the isolated Redis restore",
  );
  return parseStateJson(result.stdout, "isolated Redis witness");
}

async function captureLiveMinioState(context) {
  const script = [
    'root_user="$(cat /run/secrets/minio_root_user)"',
    'root_password="$(cat /run/secrets/minio_root_password)"',
    "attempt=1",
    'until mc alias set staging http://minio:9000 "$root_user" "$root_password" >/dev/null 2>&1; do',
    '  if [ "$attempt" -ge 60 ]; then exit 1; fi',
    "  attempt=$((attempt + 1))",
    "  sleep 2",
    "done",
    'mc ls --recursive --json "staging/$1"',
  ].join("\n");
  const result = await runCompose(
    context,
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "/bin/sh",
      "minio-init",
      "-ec",
      script,
      "sh",
      context.publicEnvironment.ATOMS_S3_BUCKET,
    ],
    "Capturing the object-storage durability witness",
  );
  return parseMinioListing(result.stdout);
}

function assertRecoveryWitness(state) {
  if (state.postgres.migrations < 1 || state.postgres.runs < 1) {
    throw new Error("staging lacks the migrated durable run required for recovery rehearsal");
  }
  if (state.postgres.activeRuns !== 0) {
    throw new Error("recovery rehearsal refuses to interrupt an active agent run");
  }
  if (state.redis.dbSize < 1 || state.redis.queueKeys < 1) {
    throw new Error("staging lacks durable queue state required for restart evidence");
  }
  if (state.objectStorage.objects < 1 || state.objectStorage.bytes < 1) {
    throw new Error("staging lacks object state required for restore evidence");
  }
}

async function verifyApplicationRevision(
  context,
  revision,
  services = REVISION_LABELED_SERVICES,
) {
  for (const service of services) {
    const container = await runCompose(
      context,
      ["ps", "-q", service],
      `Resolving the ${service} container`,
    );
    const containerId = container.stdout.trim();
    if (!/^[0-9a-f]{12,64}$/u.test(containerId)) {
      throw new Error(`${service} does not have a running container`);
    }
    const inspected = await runDocker(
      context,
      [
        "inspect",
        "--format",
        '{{ index .Config.Labels "com.atoms.revision" }}',
        containerId,
      ],
      `Verifying the ${service} revision label`,
    );
    if (inspected.stdout.trim() !== revision) {
      throw new Error(`${service} is not running the expected staging revision`);
    }
  }
}

async function verifyExternalHealth(context) {
  for (const [label, url] of [
    ["web", context.publicEnvironment.ATOMS_WEB_ORIGIN],
    [
      "Control API readiness",
      new URL("/readyz", context.publicEnvironment.ATOMS_CONTROL_API_ORIGIN).href,
    ],
  ]) {
    let response;
    try {
      response = await context.fetch(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`${label} health request failed during recovery rehearsal`);
    }
    if (
      response.status !== 200 ||
      !/^max-age=[0-9]+/u.test(
        response.headers.get("strict-transport-security") ?? "",
      )
    ) {
      throw new Error(`${label} did not pass external HTTPS health verification`);
    }
  }
}

async function waitForCommand(context, arguments_, label) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = await runDocker(context, arguments_, label, { allowFailure: true });
    if (result.status === 0) return;
    await context.delay(2_000);
  }
  throw new Error(`${label} timed out`);
}

async function waitForMinio(context, network, container, user, password) {
  const script = 'mc alias set restore "http://$1:9000" "$2" "$3" >/dev/null';
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = await runDocker(
      context,
      [
        "run",
        "--rm",
        "--network",
        network,
        "--entrypoint",
        "/bin/sh",
        MINIO_CLIENT_IMAGE,
        "-ec",
        script,
        "sh",
        container,
        user,
        password,
      ],
      "Waiting for isolated object storage",
      { allowFailure: true },
    );
    if (result.status === 0) return;
    await context.delay(2_000);
  }
  throw new Error("isolated object-storage restore target timed out");
}

async function cleanupIsolatedResources(context, resources, created) {
  let clean = true;
  for (const container of [...created.containers].reverse()) {
    const result = await runDocker(
      context,
      ["rm", "-f", container],
      "Removing an isolated recovery container",
      { allowFailure: true },
    );
    clean &&= result.status === 0;
  }
  if (created.network) {
    const result = await runDocker(
      context,
      ["network", "rm", resources.network],
      "Removing the isolated recovery network",
      { allowFailure: true },
    );
    clean &&= result.status === 0;
  }
  for (const volume of [...created.volumes].reverse()) {
    const result = await runDocker(
      context,
      ["volume", "rm", volume],
      "Removing an isolated recovery volume",
      { allowFailure: true },
    );
    clean &&= result.status === 0;
  }
  return clean;
}

function assertIsolatedResourceNames(resources) {
  for (const value of Object.values(resources)) {
    if (!/^atoms-recovery-[0-9a-f]{12}-(?:network|postgres-data|redis-data|minio-data|postgres|redis|minio)$/u.test(value)) {
      throw new Error("temporary recovery resource name escaped its isolated prefix");
    }
  }
}

function parseStateJson(output, label) {
  try {
    const value = JSON.parse(output.trim());
    if (
      value === null ||
      typeof value !== "object" ||
      Object.values(value).some(
        (entry) => !Number.isSafeInteger(entry) || entry < 0,
      )
    ) {
      throw new Error("invalid state");
    }
    return value;
  } catch {
    throw new Error(`${label} could not be verified`);
  }
}

function parseMinioListing(output) {
  let objects = 0;
  let bytes = 0;
  for (const line of lines(output)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error("object-storage listing could not be verified");
    }
    if (entry.status === "success" && entry.type !== "folder") {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new Error("object-storage listing contains an invalid size");
      }
      objects += 1;
      bytes += entry.size;
    }
  }
  return { objects, bytes };
}

function assertEqualState(label, expected, actual) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} did not preserve the recorded durable state`);
  }
}

async function directoryMetrics(path) {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("object-storage backup must not contain symlinks");
    }
    if (entry.isDirectory()) {
      const nested = await directoryMetrics(child);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      const metadata = await stat(child);
      files += 1;
      bytes += metadata.size;
    } else {
      throw new Error("object-storage backup contains an unsupported file type");
    }
  }
  return { files, bytes };
}

async function hardenDirectoryTree(path) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("object-storage backup must not contain symlinks");
    }
    if (entry.isDirectory()) {
      await hardenDirectoryTree(child);
    } else if (entry.isFile()) {
      await chmod(child, 0o600);
    } else {
      throw new Error("object-storage backup contains an unsupported file type");
    }
  }
}

function imageRepository(service) {
  return service === "orchestrator-worker"
    ? "atoms-orchestrator-worker"
    : `atoms-${service}`;
}

function runCompose(context, arguments_, label, options = {}) {
  context.log(label);
  return context.runProcess(
    "docker",
    [...context.composeArguments, ...arguments_],
    { ...options, label },
  );
}

function runDocker(context, arguments_, label, options = {}) {
  context.log(label);
  return context.runProcess("docker", arguments_, { ...options, label });
}

function runProcess(executable, arguments_, options = {}) {
  let outputDescriptor;
  let inputDescriptor;
  try {
    if (options.stdoutFile !== undefined) {
      outputDescriptor = openSync(options.stdoutFile, "wx", 0o600);
    }
    if (options.stdinFile !== undefined) {
      inputDescriptor = openSync(options.stdinFile, "r");
    }
    const result = spawnSync(executable, arguments_, {
      cwd: repositoryRoot,
      encoding: outputDescriptor === undefined ? "utf8" : undefined,
      env: { ...process.env, ...(options.environment ?? {}) },
      maxBuffer: 32 * 1024 * 1024,
      stdio: [
        inputDescriptor ?? "ignore",
        outputDescriptor ?? "pipe",
        "pipe",
      ],
    });
    if (result.error?.code === "ENOENT") {
      throw new Error(`${executable} is required for the staging recovery rehearsal`);
    }
    const status = result.status ?? 1;
    if (status !== 0 && !options.allowFailure) {
      if (options.stdoutFile !== undefined) {
        unlinkSync(options.stdoutFile);
      }
      throw new Error(`Command failed while ${options.label ?? "rehearsing recovery"}`);
    }
    return {
      status,
      stdout:
        outputDescriptor === undefined && typeof result.stdout === "string"
          ? result.stdout
          : "",
    };
  } finally {
    if (outputDescriptor !== undefined) closeSync(outputDescriptor);
    if (inputDescriptor !== undefined) closeSync(inputDescriptor);
  }
}

async function getRepositoryState(previousRevision) {
  const revision = runProcess("git", ["rev-parse", "HEAD"], {
    label: "reading the checked-out revision",
  }).stdout.trim();
  const status = runProcess("git", ["status", "--porcelain", "--untracked-files=all"], {
    label: "checking the Git worktree",
  }).stdout;
  const previous = runProcess(
    "git",
    ["merge-base", "--is-ancestor", previousRevision, revision],
    { allowFailure: true, label: "checking the previous revision ancestry" },
  );
  return {
    revision,
    dirty: status.trim().length > 0,
    previousIsAncestor: previous.status === 0,
  };
}

export function assertRedactedRecoveryEvidence(evidence) {
  const serialized = JSON.stringify(evidence);
  if (
    /https?:\/\//iu.test(serialized) ||
    /"(?:password|secret|token|credential|authorization|accessToken|refreshToken|presignedUrl)"\s*:/iu.test(serialized) ||
    /(?:Bearer\s|X-Amz-(?:Credential|Signature)|eyJ[A-Za-z0-9_-]+\.)/u.test(serialized) ||
    /\/(?:etc|var|home|workspace|run)\//iu.test(serialized) ||
    /"(?:workspace|project|run|attachment|provider|customer)(?:Id|_id)"/iu.test(serialized)
  ) {
    throw new Error("recovery evidence contains a secret, path, URL, or tenant identifier");
  }
}

export async function writeRedactedEvidence(path, evidence) {
  assertRedactedRecoveryEvidence(evidence);
  const parent = dirname(path);
  const canonicalParent = await realpath(parent);
  if (resolve(parent) !== canonicalParent) {
    throw new Error("evidence parent directory must not traverse symlinks");
  }
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
    }
    if (error?.code === "EEXIST") {
      throw new Error("recovery evidence already exists and will not be overwritten");
    }
    throw error;
  }
  await handle.close();
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o7777) !== 0o600
  ) {
    await rm(path, { force: true }).catch(() => undefined);
    throw new Error("recovery evidence must be a regular mode-0600 file");
  }
}

async function requireMissing(path, label) {
  try {
    await lstat(path);
    throw new Error(`${label} already exists and will not be overwritten`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function isInside(candidate, parent) {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

function lines(value) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function main() {
  try {
    const options = parseRecoveryArguments(process.argv.slice(2));
    await rehearseStagingRecovery(options);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Staging recovery rehearsal failed",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}

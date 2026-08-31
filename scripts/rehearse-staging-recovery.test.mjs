import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  APPLICATION_SERVICES,
  BACKUP_RESTORE_CONFIRMATION,
  RESTART_CONFIRMATION,
  ROLLBACK_CONFIRMATION,
  assertRedactedRecoveryEvidence,
  createBackups,
  parseRecoveryArguments,
  rehearseRestart,
  rehearseRollbackAndReturn,
  rehearseStagingRecovery,
  restoreBackupsInIsolation,
  validateRecoveryCommandOptions,
  writeRedactedEvidence,
} from "./rehearse-staging-recovery.mjs";

const currentRevision = "a".repeat(40);
const previousRevision = "b".repeat(40);
const containerId = "c".repeat(64);
const durableState = Object.freeze({
  postgres: { migrations: 8, runs: 1, activeRuns: 0 },
  redis: { dbSize: 9, queueKeys: 7 },
  objectStorage: { objects: 1, bytes: 37 },
});

function recoveryOptions() {
  return {
    environmentFile: "/etc/atoms/staging/staging.env",
    secretsDirectory: "/etc/atoms/staging/secrets",
    bootstrapEvidence: "/var/lib/atoms/staging/evidence/persistence-bootstrap.json",
    smokeEvidence: "/var/lib/atoms/staging/evidence/authenticated-smoke.json",
    backupDirectory: "/var/lib/atoms/staging/backups/recovery-gh-22",
    evidenceOutput: "/var/lib/atoms/staging/evidence/recovery-rehearsal.json",
    previousRevision,
    ciRunId: "33293139043",
    changeTicket: "GH-22",
    restartConfirmation: RESTART_CONFIRMATION,
    backupRestoreConfirmation: BACKUP_RESTORE_CONFIRMATION,
    rollbackConfirmation: ROLLBACK_CONFIRMATION,
  };
}

function publicEnvironment() {
  return {
    ATOMS_IMAGE_TAG: currentRevision,
    ATOMS_WEB_ORIGIN: "https://staging.example.test",
    ATOMS_CONTROL_API_ORIGIN: "https://api.staging.example.test",
    ATOMS_RUN_QUEUE_PREFIX: "atoms-staging",
    ATOMS_S3_BUCKET: "atoms-staging-attachments",
  };
}

function operationContext(overrides = {}) {
  return {
    options: recoveryOptions(),
    paths: {
      backupDirectory: recoveryOptions().backupDirectory,
      evidenceOutput: recoveryOptions().evidenceOutput,
    },
    publicEnvironment: publicEnvironment(),
    currentRevision,
    previousRevision,
    composeArguments: [
      "compose",
      "--env-file",
      recoveryOptions().environmentFile,
      "-f",
      "/workspace/deploy/staging/compose.yaml",
    ],
    randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    delay: async () => {},
    fetch: async () => healthyResponse(),
    log() {},
    ...overrides,
  };
}

function healthyResponse() {
  return {
    status: 200,
    headers: new Headers({ "strict-transport-security": "max-age=31536000" }),
  };
}

function includesArgument(arguments_, fragment) {
  return arguments_.some(
    (value) => typeof value === "string" && value.includes(fragment),
  );
}

test("parses all three exact live confirmations and absolute evidence paths", () => {
  const options = recoveryOptions();
  assert.deepEqual(
    parseRecoveryArguments([
      "--",
      "--env-file",
      options.environmentFile,
      "--secrets-dir",
      options.secretsDirectory,
      "--bootstrap-evidence",
      options.bootstrapEvidence,
      "--smoke-evidence",
      options.smokeEvidence,
      "--backup-dir",
      options.backupDirectory,
      "--evidence-out",
      options.evidenceOutput,
      "--previous-revision",
      options.previousRevision,
      "--ci-run-id",
      options.ciRunId,
      "--change-ticket",
      options.changeTicket,
      "--restart-confirmation",
      options.restartConfirmation,
      "--backup-restore-confirmation",
      options.backupRestoreConfirmation,
      "--rollback-confirmation",
      options.rollbackConfirmation,
    ]),
    options,
  );
});

test("rejects near-match confirmations, unsafe paths, and abbreviated revisions", () => {
  const nearMatch = {
    ...recoveryOptions(),
    rollbackConfirmation: `${ROLLBACK_CONFIRMATION}_YES`,
    previousRevision: "abc123",
    backupDirectory: "/var/lib/atoms/staging/backups:unsafe",
  };
  const result = validateRecoveryCommandOptions(nearMatch);
  assert.ok(
    result.violations.some((value) => value.includes("--rollback-confirmation")),
  );
  assert.ok(
    result.violations.some((value) => value.includes("full lowercase Git SHA")),
  );
  assert.ok(
    result.violations.some((value) => value.includes("Docker bind mount")),
  );

  assert.throws(
    () =>
      parseRecoveryArguments([
        "--env-file",
        "/tmp/staging.env",
        "--env-file",
        "/tmp/duplicate.env",
      ]),
    /may be supplied only once/u,
  );
});

test("orchestrates the complete redacted recovery handoff", async () => {
  const calls = [];
  let written;
  const prerequisites = {
    persistenceBootstrap: {
      schemaVersion: "atoms-staging-persistence-bootstrap.v1",
      verified: true,
    },
    authenticatedSmoke: {
      schemaVersion: "atoms.staging.authenticated-smoke.v1",
      verified: true,
    },
  };
  const evidence = await rehearseStagingRecovery(recoveryOptions(), {
    validateDeployment: async () => ({ ok: true, violations: [] }),
    readPublicEnvironment: async () => publicEnvironment(),
    getRepositoryState: async () => ({
      revision: currentRevision,
      dirty: false,
      previousIsAncestor: true,
    }),
    preparePaths: async (options) => ({
      bootstrapEvidence: options.bootstrapEvidence,
      smokeEvidence: options.smokeEvidence,
      backupDirectory: options.backupDirectory,
      evidenceOutput: options.evidenceOutput,
    }),
    readPrerequisites: async () => prerequisites,
    createBackupDirectory: async () => calls.push("backup-directory"),
    ensureCurrentStack: async () => calls.push("current-stack"),
    createBackups: async () => {
      calls.push("backup");
      return { state: durableState };
    },
    restoreBackupsInIsolation: async () => {
      calls.push("restore");
      return {
        postgres: "backup-created-and-isolated-restore-verified",
        redis: "backup-created-and-isolated-restore-verified",
        objectStorage: "backup-created-and-isolated-restore-verified",
        isolatedResourcesRemoved: true,
      };
    },
    rehearseRestart: async () => {
      calls.push("restart");
      return {
        persistentServicesRestarted: true,
        durableDatabaseStatePreserved: true,
        queuedWorkStatePreserved: true,
        objectStatePreserved: true,
        currentRevisionHealthy: true,
      };
    },
    rehearseRollbackAndReturn: async () => {
      calls.push("rollback");
      return {
        previousRevisionHealthy: true,
        databaseMigrationsReversed: false,
        persistentVolumesChanged: false,
        currentRevisionRestored: true,
        currentRevisionHealthy: true,
      };
    },
    writeEvidence: async (path, value) => {
      written = { path, value };
    },
    now: () => new Date("2026-08-31T15:00:00.000Z"),
    log() {},
  });

  assert.deepEqual(calls, [
    "backup-directory",
    "current-stack",
    "backup",
    "restore",
    "restart",
    "rollback",
  ]);
  assert.equal(evidence.currentRevision, currentRevision);
  assert.equal(evidence.previousRevision, previousRevision);
  assert.equal(evidence.backupRestore.isolatedResourcesRemoved, true);
  assert.equal(evidence.rollback.currentRevisionRestored, true);
  assert.equal(evidence.gates.every(({ status }) => status === "PASSED"), true);
  assert.deepEqual(written, {
    path: recoveryOptions().evidenceOutput,
    value: evidence,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /https?:\/\//u);
});

test("refuses incomplete prerequisite evidence before creating a backup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atoms-recovery-prerequisites-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const bootstrapEvidence = join(directory, "bootstrap.json");
  const smokeEvidence = join(directory, "smoke.json");
  await writeFile(
    bootstrapEvidence,
    `${JSON.stringify({
      version: "atoms-staging-persistence-bootstrap.v1",
      commitSha: currentRevision,
      changeTicket: "GH-22",
      gates: [
        "secret_safe_preflight",
        "clean_revision_pin",
        "external_volume_ownership",
        "persistent_service_health",
        "private_attachment_bucket",
        "prisma_migrate_deploy",
        "prisma_migrate_status",
      ].map((name) => ({ name, status: "PASSED" })),
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    smokeEvidence,
    `${JSON.stringify({
      schemaVersion: "atoms.staging.authenticated-smoke.v1",
      outcome: "passed",
      revision: currentRevision,
      changeTicket: "GH-22",
      checks: ["web_https_and_csp"],
    })}\n`,
    { mode: 0o600 },
  );
  const options = {
    ...recoveryOptions(),
    bootstrapEvidence,
    smokeEvidence,
    backupDirectory: join(directory, "backup-target"),
    evidenceOutput: join(directory, "recovery.json"),
  };
  let backupDirectoryCreated = false;

  await assert.rejects(
    rehearseStagingRecovery(options, {
      validateDeployment: async () => ({ ok: true, violations: [] }),
      readPublicEnvironment: async () => publicEnvironment(),
      getRepositoryState: async () => ({
        revision: currentRevision,
        dirty: false,
        previousIsAncestor: true,
      }),
      preparePaths: async () => ({
        bootstrapEvidence,
        smokeEvidence,
        backupDirectory: options.backupDirectory,
        evidenceOutput: options.evidenceOutput,
      }),
      createBackupDirectory: async () => {
        backupDirectoryCreated = true;
      },
      log() {},
    }),
    /authenticated smoke evidence does not pass/u,
  );
  assert.equal(backupDirectoryCreated, false);
});

test("restores PostgreSQL, Redis, and object storage only into isolated resources", async () => {
  const calls = [];
  const runProcess = async (executable, arguments_, options = {}) => {
    calls.push({ executable, arguments_, options });
    if (includesArgument(arguments_, "psql")) {
      return { status: 0, stdout: `${JSON.stringify(durableState.postgres)}\n` };
    }
    if (includesArgument(arguments_, "db_size=")) {
      return { status: 0, stdout: `${JSON.stringify(durableState.redis)}\n` };
    }
    if (includesArgument(arguments_, "mc ls --recursive")) {
      return {
        status: 0,
        stdout: `${JSON.stringify({ status: "success", type: "file", size: 37, key: "redacted-by-test" })}\n`,
      };
    }
    return { status: 0, stdout: "" };
  };
  const context = operationContext({ runProcess });
  const result = await restoreBackupsInIsolation(context, {
    state: durableState,
    postgresPath: join(context.paths.backupDirectory, "postgres.dump"),
    redisPath: join(context.paths.backupDirectory, "redis.rdb"),
    objectStoragePath: join(context.paths.backupDirectory, "object-storage"),
  });

  assert.equal(result.isolatedResourcesRemoved, true);
  const commandText = calls
    .map(({ executable, arguments_ }) => `${executable} ${arguments_.join(" ")}`)
    .join("\n");
  assert.match(commandText, /network create --internal/u);
  assert.match(commandText, /atoms-recovery-a{12}-postgres-data/u);
  assert.match(commandText, /atoms-recovery-a{12}-redis-data/u);
  assert.match(commandText, /atoms-recovery-a{12}-minio-data/u);
  assert.match(commandText, /pg_restore/u);
  assert.match(commandText, /mc mirror --quiet \/backup/u);
  assert.match(commandText, /network rm atoms-recovery-a{12}-network/u);
  assert.match(commandText, /volume rm atoms-recovery-a{12}-postgres-data/u);
  assert.doesNotMatch(commandText, /atoms-staging_atoms_(?:postgres|redis|minio)_data/u);
});

test("consistent backup quiesces writers and always restores the current stack", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atoms-recovery-backup-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const runProcess = async (executable, arguments_, options = {}) => {
    calls.push({ executable, arguments_, options });
    if (options.label === "Creating the protected PostgreSQL backup") {
      throw new Error("planned backup failure");
    }
    if (includesArgument(arguments_, "psql")) {
      return { status: 0, stdout: `${JSON.stringify(durableState.postgres)}\n` };
    }
    if (includesArgument(arguments_, "db_size=")) {
      return { status: 0, stdout: `${JSON.stringify(durableState.redis)}\n` };
    }
    if (includesArgument(arguments_, "mc ls --recursive")) {
      return {
        status: 0,
        stdout: `${JSON.stringify({ status: "success", type: "file", size: 37 })}\n`,
      };
    }
    if (arguments_.includes("-q") && arguments_.includes("ps")) {
      return { status: 0, stdout: `${containerId}\n` };
    }
    if (arguments_[0] === "inspect") {
      return { status: 0, stdout: `${currentRevision}\n` };
    }
    return { status: 0, stdout: "" };
  };
  const context = operationContext({
    runProcess,
    paths: { backupDirectory: directory },
  });

  await assert.rejects(createBackups(context), /planned backup failure/u);
  assert.equal(
    calls.some(
      ({ options }) =>
        options.label ===
        "Stopping application writers for a consistent protected backup",
    ),
    true,
  );
  assert.equal(
    calls.some(({ options }) => options.label === "Restoring the current staging revision"),
    true,
  );
});

test("restart rehearsal restores the current stack after an operational failure", async () => {
  const calls = [];
  let failRestart = true;
  const runProcess = async (executable, arguments_, options = {}) => {
    calls.push({ executable, arguments_, options });
    if (
      failRestart &&
      options.label === "Restarting persistent staging services"
    ) {
      failRestart = false;
      throw new Error("planned restart failure");
    }
    if (includesArgument(arguments_, "psql")) {
      return { status: 0, stdout: `${JSON.stringify(durableState.postgres)}\n` };
    }
    if (includesArgument(arguments_, "db_size=")) {
      return { status: 0, stdout: `${JSON.stringify(durableState.redis)}\n` };
    }
    if (includesArgument(arguments_, "mc ls --recursive")) {
      return {
        status: 0,
        stdout: `${JSON.stringify({ status: "success", type: "file", size: 37 })}\n`,
      };
    }
    if (arguments_.includes("-q") && arguments_.includes("ps")) {
      return { status: 0, stdout: `${containerId}\n` };
    }
    if (arguments_[0] === "inspect") {
      return { status: 0, stdout: `${currentRevision}\n` };
    }
    return { status: 0, stdout: "" };
  };
  const context = operationContext({ runProcess });
  await assert.rejects(
    rehearseRestart(context),
    /planned restart failure/u,
  );
  assert.equal(
    calls.some(({ options }) => options.label === "Restoring the current staging revision"),
    true,
  );
  assert.equal(
    calls.some(
      ({ options }) =>
        options.label === "Verifying the reverse-proxy revision label",
    ),
    true,
  );
});

test("rollback rehearsal always rolls forward when previous health fails", async () => {
  const calls = [];
  let activeRevision = currentRevision;
  let externalChecks = 0;
  const runProcess = async (executable, arguments_, options = {}) => {
    calls.push({ executable, arguments_, options });
    if (
      options.label === "Rolling application services back to the retained revision"
    ) {
      activeRevision = options.environment.ATOMS_IMAGE_TAG;
    }
    if (options.label === "Restoring the current staging revision") {
      activeRevision = options.environment.ATOMS_IMAGE_TAG;
    }
    if (arguments_.includes("-q") && arguments_.includes("ps")) {
      return { status: 0, stdout: `${containerId}\n` };
    }
    if (arguments_[0] === "inspect") {
      return { status: 0, stdout: `${activeRevision}\n` };
    }
    return { status: 0, stdout: "" };
  };
  const context = operationContext({
    runProcess,
    fetch: async () => {
      externalChecks += 1;
      if (externalChecks === 1) throw new Error("planned previous health failure");
      return healthyResponse();
    },
  });

  await assert.rejects(
    rehearseRollbackAndReturn(context),
    /health request failed/u,
  );
  assert.equal(activeRevision, currentRevision);
  assert.equal(
    calls.some(({ options }) => options.label === "Restoring the current staging revision"),
    true,
  );
  const previousRevisionInspections = calls.filter(
    ({ options }) =>
      options.label?.startsWith("Verifying the ") &&
      options.label?.endsWith(" revision label") &&
      !options.label.includes("reverse-proxy"),
  );
  assert.ok(previousRevisionInspections.length >= APPLICATION_SERVICES.length);
});

test("evidence writer is mode-0600, redacted, and never overwrites", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atoms-recovery-evidence-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "recovery.json");
  const evidence = {
    schemaVersion: "atoms.staging.recovery-rehearsal.v1",
    outcome: "passed",
    ciRunId: "33293139043",
  };
  await writeRedactedEvidence(path, evidence);
  assert.equal((await stat(path)).mode & 0o7777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), evidence);

  await assert.rejects(
    writeRedactedEvidence(path, { ...evidence, outcome: "replacement" }),
    /already exists/u,
  );
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), evidence);

  assert.throws(
    () =>
      assertRedactedRecoveryEvidence({
        ...evidence,
        workspaceId: "00000000-0000-4000-8000-000000000000",
      }),
    /tenant identifier/u,
  );
  assert.throws(
    () => assertRedactedRecoveryEvidence({ ...evidence, endpoint: "https://example.test" }),
    /URL/u,
  );
});

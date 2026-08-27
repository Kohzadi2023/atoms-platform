import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STAGING_PERSISTENCE_CONFIRMATION,
  bootstrapStagingPersistence,
  parseBootstrapArguments,
} from "./bootstrap-staging-persistence.mjs";
import {
  PERSISTENT_SERVICES,
  persistentVolumeLabels,
  persistentVolumeName,
} from "./staging-persistence-contract.mjs";

const revision = "a".repeat(40);
const projectName = "atoms-staging";
const composePath = fileURLToPath(
  new URL("../deploy/staging/compose.yaml", import.meta.url),
);

function bootstrapOptions() {
  return {
    environmentFile: "/etc/atoms/staging/staging.env",
    secretsDirectory: "/etc/atoms/staging/secrets",
    evidenceOutput: "/var/lib/atoms/staging/evidence/bootstrap.json",
    changeTicket: "GH-22",
    confirmation: STAGING_PERSISTENCE_CONFIRMATION,
  };
}

function createHarness(options = {}) {
  const calls = [];
  const volumeLabels = new Map();
  for (const role of options.existingRoles ?? ["redis"]) {
    volumeLabels.set(
      persistentVolumeName(projectName, role),
      persistentVolumeLabels(projectName, role),
    );
  }
  if (options.invalidRole !== undefined) {
    volumeLabels.set(persistentVolumeName(projectName, options.invalidRole), {
      "com.atoms.environment": "production",
    });
  }
  let writtenEvidence;

  return {
    calls,
    get writtenEvidence() {
      return writtenEvidence;
    },
    dependencies: {
      validateDeployment: async () => ({ ok: true, violations: [] }),
      readPublicEnvironment: async () => ({
        COMPOSE_PROJECT_NAME: projectName,
        ATOMS_IMAGE_TAG: revision,
      }),
      getRepositoryState: async () => ({ revision, dirty: false }),
      listMigrationNames: async () => [
        "20260731140000_contract_sprint_init",
        "20260801150000_phase2_validation_preview",
      ],
      prepareEvidenceOutput: async (path) => path,
      now: () => new Date("2026-08-27T15:00:00.000Z"),
      log() {},
      writeEvidence: async (path, evidence) => {
        writtenEvidence = { path, evidence };
      },
      runProcess: async (executable, arguments_, runOptions = {}) => {
        calls.push({ executable, arguments_, runOptions });
        if (arguments_[0] === "volume" && arguments_[1] === "inspect") {
          const name = arguments_.at(-1);
          const labels = volumeLabels.get(name);
          if (labels === undefined) return { status: 1, stdout: "" };
          return { status: 0, stdout: `${JSON.stringify(labels)}\n` };
        }
        if (arguments_[0] === "volume" && arguments_[1] === "create") {
          const name = arguments_.at(-1);
          const labels = {};
          for (let index = 2; index < arguments_.length - 1; index += 2) {
            assert.equal(arguments_[index], "--label");
            const [label, ...value] = arguments_[index + 1].split("=");
            labels[label] = value.join("=");
          }
          volumeLabels.set(name, labels);
          return { status: 0, stdout: `${name}\n` };
        }
        if (arguments_.includes("ps")) {
          return { status: 0, stdout: `${PERSISTENT_SERVICES.join("\n")}\n` };
        }
        if (
          options.failMigration === true &&
          arguments_.includes("run") &&
          arguments_.at(-1) === "migrate"
        ) {
          throw new Error("Command failed while Applying Prisma migrations");
        }
        return { status: 0, stdout: "" };
      },
    },
  };
}

test("parses the explicit live bootstrap contract", () => {
  assert.deepEqual(
    parseBootstrapArguments([
      "--",
      "--env-file",
      "/etc/atoms/staging/staging.env",
      "--secrets-dir",
      "/etc/atoms/staging/secrets",
      "--evidence-out",
      "/var/lib/atoms/staging/evidence/bootstrap.json",
      "--change-ticket",
      "GH-22",
      "--confirmation",
      STAGING_PERSISTENCE_CONFIRMATION,
    ]),
    bootstrapOptions(),
  );
  assert.throws(
    () =>
      parseBootstrapArguments([
        "--env-file",
        "relative.env",
        "--secrets-dir",
        "/tmp/secrets",
        "--evidence-out",
        "/tmp/evidence.json",
        "--change-ticket",
        "GH-22",
        "--confirmation",
        STAGING_PERSISTENCE_CONFIRMATION,
      ]),
    /environmentFile must be an absolute path/u,
  );
  assert.throws(
    () =>
      parseBootstrapArguments([
        "--env-file",
        "/tmp/staging.env",
        "--secrets-dir",
        "/tmp/secrets",
        "--evidence-out",
        "/tmp/evidence.json",
        "--change-ticket",
        "GH-22",
        "--confirmation",
        "yes",
    ]),
    new RegExp(STAGING_PERSISTENCE_CONFIRMATION, "u"),
  );
  assert.throws(
    () =>
      parseBootstrapArguments([
        "--env-file",
        "/tmp/staging.env",
        "--env-file",
        "/tmp/other.env",
      ]),
    /option is duplicated: --env-file/u,
  );
});

test("bootstraps only persistent dependencies and emits redacted evidence", async () => {
  const harness = createHarness();
  const evidence = await bootstrapStagingPersistence(
    bootstrapOptions(),
    harness.dependencies,
  );

  assert.equal(evidence.commitSha, revision);
  assert.equal(evidence.changeTicket, "GH-22");
  assert.deepEqual(
    evidence.volumes.map(({ role, disposition }) => ({ role, disposition })),
    [
      { role: "postgres", disposition: "created" },
      { role: "redis", disposition: "reused" },
      { role: "minio", disposition: "created" },
    ],
  );
  assert.deepEqual(harness.writtenEvidence, {
    path: bootstrapOptions().evidenceOutput,
    evidence,
  });

  const commandText = harness.calls
    .map(({ executable, arguments_ }) => `${executable} ${arguments_.join(" ")}`)
    .join("\n");
  assert.match(commandText, /compose .* build --pull migrate/u);
  assert.match(commandText, /compose .* up -d --wait --wait-timeout 600 postgres redis minio clamav/u);
  assert.match(commandText, /compose .* run --rm --no-deps -T minio-init/u);
  assert.match(commandText, /compose .* run --rm --no-deps -T migrate$/mu);
  assert.match(commandText, /migrate status/u);
  assert.doesNotMatch(commandText, /\bdown\b/u);
  assert.doesNotMatch(commandText, /orchestrator-worker|preview-gateway|reverse-proxy/u);
});

test("refuses to adopt an existing volume with the wrong ownership labels", async () => {
  const harness = createHarness({ invalidRole: "postgres" });
  await assert.rejects(
    bootstrapStagingPersistence(bootstrapOptions(), harness.dependencies),
    /postgres persistence volume has invalid ownership labels/u,
  );
  assert.equal(harness.writtenEvidence, undefined);
  assert.equal(harness.calls.some(({ arguments_ }) => arguments_.includes("up")), false);
});

test("does not issue passing evidence after a migration failure", async () => {
  const harness = createHarness({ failMigration: true });
  await assert.rejects(
    bootstrapStagingPersistence(bootstrapOptions(), harness.dependencies),
    /Applying Prisma migrations/u,
  );
  assert.equal(harness.writtenEvidence, undefined);
  assert.equal(harness.calls.some(({ arguments_ }) => arguments_.includes("status")), false);
});

test("requires a clean checkout pinned to the deployment revision", async () => {
  const dirtyHarness = createHarness();
  dirtyHarness.dependencies.getRepositoryState = async () => ({
    revision,
    dirty: true,
  });
  await assert.rejects(
    bootstrapStagingPersistence(bootstrapOptions(), dirtyHarness.dependencies),
    /clean Git checkout/u,
  );
  assert.equal(dirtyHarness.calls.length, 0);

  const staleHarness = createHarness();
  staleHarness.dependencies.getRepositoryState = async () => ({
    revision: "b".repeat(40),
    dirty: false,
  });
  await assert.rejects(
    bootstrapStagingPersistence(bootstrapOptions(), staleHarness.dependencies),
    /ATOMS_IMAGE_TAG must exactly match/u,
  );
  assert.equal(staleHarness.calls.length, 0);
});

test("critical data volumes are external to the Compose project", async () => {
  const compose = await readFile(composePath, "utf8");
  for (const role of ["postgres", "redis", "minio"]) {
    assert.match(
      compose,
      new RegExp(
        `atoms_${role}_data:\\n\\s+name: \\$\\{COMPOSE_PROJECT_NAME[^\\n]*\\}_atoms_${role}_data\\n\\s+external: true`,
        "u",
      ),
    );
  }
});

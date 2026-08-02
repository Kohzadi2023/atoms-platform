import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const outputPath = resolve(
  process.env.PHASE3_DURABILITY_EVIDENCE_PATH ??
    "artifacts/phase3-durability-evidence.json",
);
const serverUrl = requireValue("GITHUB_SERVER_URL");
const repository = requireValue("GITHUB_REPOSITORY");
const runId = requireValue("GITHUB_RUN_ID");
const commitSha = requireValue("GITHUB_SHA");
const changeTicket = requireValue("PHASE3_STAGING_CHANGE_TICKET");
if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/.test(changeTicket)) {
  throw new Error("Invalid staging change-ticket identifier");
}

const evidence = {
  version: "phase3-durability-staging.v1",
  changeTicket,
  recordedAt: new Date().toISOString(),
  runUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
  commitSha,
  postgresVersion: "17",
  gates: [
    { name: "phase2_to_phase3_upgrade", status: "PASSED" },
    { name: "full_migration_pack_from_empty", status: "PASSED" },
    { name: "prisma_migration_history", status: "PASSED" },
    { name: "postgres_cas_and_unique_sweep_lock", status: "PASSED" },
    { name: "bullmq_scheduler_and_versioned_recovery_job", status: "PASSED" },
    { name: "report_only_orphan_observation", status: "PASSED" },
  ],
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log(`Wrote Phase 3 durability evidence to ${outputPath}`);

function requireValue(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

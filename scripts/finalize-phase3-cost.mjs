import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { Phase3ProviderStagingEvidenceSchema } from "../packages/contracts/dist/index.js";
import { parseCadMicros, PHASE3_COST_CONFIRMATION } from "./phase3-cost.mjs";

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

export function finalizationInputs(env) {
  requireThat(env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_REF === "refs/heads/main",
    "Cost finalization requires a manual main-branch run");
  requireThat(env.PHASE3_COST_CONFIRMATION === PHASE3_COST_CONFIRMATION,
    "Exact post-cleanup actual-cost attestation is required");
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? ""), "Repository is invalid");
  requireThat(/^[1-9]\d*$/.test(env.PHASE3_SOURCE_RUN_ID ?? ""), "Source run ID is invalid");
  requireThat(/^[1-9]\d*$/.test(env.PHASE3_SOURCE_RUN_ATTEMPT ?? ""), "Source run attempt is invalid");
  const runAttempt = Number(env.PHASE3_SOURCE_RUN_ATTEMPT);
  requireThat(Number.isSafeInteger(runAttempt), "Source run attempt is invalid");
  requireThat(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/.test(env.PHASE3_STAGING_CHANGE_TICKET ?? ""), "Change ticket is invalid");
  requireThat(/^[a-f0-9]{64}$/.test(env.PHASE3_MEASUREMENT_SOURCE_SHA256 ?? ""), "A SHA-256 fingerprint of the actual cost record is required");
  requireThat(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(env.GITHUB_ACTOR ?? ""), "Recording actor is invalid");
  return {
    repository: env.GITHUB_REPOSITORY,
    runId: env.PHASE3_SOURCE_RUN_ID,
    runAttempt,
    changeTicket: env.PHASE3_STAGING_CHANGE_TICKET,
    measuredCadMicros: parseCadMicros(env.PHASE3_STAGING_MEASURED_COST_CAD),
    measurementSourceSha256: env.PHASE3_MEASUREMENT_SOURCE_SHA256,
    recordedBy: env.GITHUB_ACTOR,
  };
}

export function verifySourceRun({ run, jobs }, input) {
  requireThat(run?.repository?.full_name === input.repository && run?.head_repository?.full_name === input.repository,
    "Source run must belong to this repository, not a fork");
  requireThat(String(run.id) === input.runId && run.run_attempt === input.runAttempt,
    "Source run or attempt does not match; do not reuse evidence after a rerun");
  requireThat(run.event === "workflow_dispatch" && run.head_branch === "main" &&
    run.path === ".github/workflows/phase3-staging.yml", "Source must be the manual main-branch Phase 3 workflow");
  requireThat(run.status === "completed" && run.conclusion === "failure" && /^[a-f0-9]{40}$/.test(run.head_sha ?? ""),
    "Source lifecycle must be completed and awaiting the cost gate");
  requireThat(Number.isFinite(Date.parse(run.run_started_at)) && Number.isFinite(Date.parse(run.updated_at)),
    "Source run timestamps are invalid");
  requireThat(Array.isArray(jobs?.jobs) && jobs.total_count === jobs.jobs.length && jobs.jobs.length === 3,
    "Complete source job metadata is required");
  for (const name of ["preflight", "migration-and-durability", "provider-exit"]) {
    const matches = jobs.jobs.filter((job) => job.name === name);
    requireThat(matches.length === 1 && matches[0].run_attempt === input.runAttempt &&
      matches[0].status === "completed" && matches[0].conclusion === (name === "provider-exit" ? "failure" : "success"),
    "Source lifecycle jobs did not finish as required");
    if (name === "provider-exit") {
      const steps = matches[0].steps;
      requireThat(Array.isArray(steps) && steps.length > 0, "Source provider steps are missing");
      const failed = steps.filter((step) => step.conclusion !== "success" && step.conclusion !== "skipped");
      requireThat(failed.length === 1 && failed[0].name === "Await cost finalization" &&
        failed[0].conclusion === "failure", "Source failed for a reason other than pending cost");
    }
  }
  return run;
}

export function finalizeCostEvidence(sourceText, input, metadata, recordedAt = new Date()) {
  const run = verifySourceRun(metadata, input);
  requireThat(typeof sourceText === "string" && Buffer.byteLength(sourceText) <= 262_144, "Source evidence is too large");
  let parsed;
  try { parsed = JSON.parse(sourceText); } catch { throw new Error("Source evidence is not valid JSON"); }
  const checked = Phase3ProviderStagingEvidenceSchema.safeParse(parsed);
  requireThat(checked.success, "Source evidence does not satisfy the current evidence contract");
  const evidence = checked.data;
  requireThat(evidence.result === "AWAITING_COST", "Only a clean lifecycle awaiting cost can be finalized");
  requireThat(evidence.changeTicket === input.changeTicket, "Change ticket does not match the source evidence");
  requireThat(evidence.workflowRun?.repository === input.repository && evidence.workflowRun?.runId === input.runId &&
    evidence.workflowRun?.runAttempt === input.runAttempt && evidence.workflowRun?.commitSha === run.head_sha,
  "Source evidence is not bound to the verified workflow run, attempt and commit");
  requireThat(Date.parse(evidence.startedAt) >= Date.parse(run.run_started_at) &&
    Date.parse(evidence.completedAt) <= Date.parse(run.updated_at) && recordedAt.getTime() >= Date.parse(run.updated_at),
  "Cost must be recorded after the exact source lifecycle has completed");
  const withinBudget = input.measuredCadMicros <= evidence.approvedBudgetCadMicros &&
    input.measuredCadMicros <= evidence.variableCostTargetCadMicros;
  return Phase3ProviderStagingEvidenceSchema.parse({
    ...evidence,
    result: withinBudget ? "PASSED" : "FAILED",
    measuredVariableCostCadMicros: input.measuredCadMicros,
    costMeasurement: {
      recordedAt: recordedAt.toISOString(),
      recordedBy: input.recordedBy,
      measurementSourceSha256: input.measurementSourceSha256,
      sourceEvidenceSha256: createHash("sha256").update(sourceText).digest("hex"),
    },
    gates: evidence.gates.map((gate) => gate.name === "variable_cost" ? {
      ...gate, status: withinBudget ? "PASSED" : "FAILED", durationMs: 0,
      details: {
        measuredCadMicros: input.measuredCadMicros,
        approvedBudgetCadMicros: evidence.approvedBudgetCadMicros,
        targetCadMicros: evidence.variableCostTargetCadMicros,
        measurement: "operator_attested_after_cleanup",
      },
    } : gate),
    errors: withinBudget ? [] : [{ code: "ACTUAL_COST_BUDGET_EXCEEDED", message: "Actual cost exceeds the approved budget or Phase 3 target" }],
  });
}

async function sourceMetadata(input, token) {
  requireThat(typeof token === "string" && token.length > 0, "A workflow-scoped GitHub token is required");
  const base = `https://api.github.com/repos/${input.repository}/actions/runs/${input.runId}`;
  const read = async (url) => {
    const response = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    requireThat(response.ok, "Source workflow metadata could not be verified");
    return response.json();
  };
  const [run, jobs] = await Promise.all([read(base), read(`${base}/attempts/${input.runAttempt}/jobs?per_page=100`)]);
  return { run, jobs };
}

async function main() {
  const input = finalizationInputs(process.env);
  const metadata = await sourceMetadata(input, process.env.GITHUB_TOKEN);
  verifySourceRun(metadata, input);
  if (process.argv[2] === "--verify-source") {
    console.log("Source lifecycle and exact attempt verified; no provider operations executed.");
    return;
  }
  requireThat(process.argv.length === 2, "Unexpected finalizer argument");
  const sourceText = await readFile("artifacts/phase3-source/phase3-provider-evidence.json", "utf8");
  const result = finalizeCostEvidence(sourceText, input, metadata);
  const output = "artifacts/phase3-provider-final-evidence.json";
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(`Phase 3 final provider evidence: ${result.result}; no provider operations executed.`);
  if (result.result !== "PASSED") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Never echo untrusted evidence, metadata, environment values or stack traces.
    console.error("Phase 3 cost finalization failed; source, attestation and cleanup must be verified.");
    process.exitCode = 1;
  });
}

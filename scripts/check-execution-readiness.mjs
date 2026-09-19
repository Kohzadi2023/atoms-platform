// Read-only check of the live-execution gate (docs/adr/production-execution-gate.md, G7).
//
//   node scripts/check-execution-readiness.mjs --origin https://<control-api> [--for-enable] [--json]
//
// It only issues GET /readyz. Run it with --for-enable as the step before anyone
// flips RUN_EXECUTION_ENABLED, and without it afterwards to catch locks that disagree.
//
// Exit codes: 0 acceptable, 1 not acceptable (gates failing or locks inconsistent),
// 2 the check itself could not run (usage, unreachable, malformed response).

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const GATE_NAMES = {
  G1: "Cost boundary: per-run budget and per-workspace daily ceiling configured on the worker",
  G4: "Attachment trust boundary: reference contract intact",
  G5: "Network egress: live probe recorded (set SANDBOX_EGRESS_VERIFIED_AT after it passes)",
  LOCK_3: "Provider credentials present on the worker",
};

const WORKER_STATES = new Set(["reporting", "missing", "stale"]);

export class ReadinessResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReadinessResponseError";
  }
}

/** Validates the /readyz body and returns the execution block. Throws when it is not usable. */
export function parseReadyz(body) {
  const fail = (message) => {
    throw new ReadinessResponseError(`/readyz response is not usable: ${message}`);
  };
  if (typeof body !== "object" || body === null) fail("not a JSON object");
  if (body.status !== "ready") fail("status is not 'ready'");
  const execution = body.execution;
  if (typeof execution !== "object" || execution === null) {
    fail("no execution block (is this a Control API that predates the readiness gate?)");
  }
  for (const key of ["controlPlaneEnabled", "preconditionsMet", "executionReady", "inconsistent"]) {
    if (typeof execution[key] !== "boolean") fail(`execution.${key} is not a boolean`);
  }
  if (!Array.isArray(execution.failingGates)) fail("execution.failingGates is not a list");
  if (!WORKER_STATES.has(execution.workerState)) fail("execution.workerState is unknown");
  // The summary must agree with the detail, otherwise the response cannot be trusted.
  if (execution.preconditionsMet !== (execution.failingGates.length === 0)) {
    fail("preconditionsMet disagrees with failingGates");
  }
  if (execution.executionReady !== (execution.controlPlaneEnabled && execution.preconditionsMet)) {
    fail("executionReady disagrees with its inputs");
  }
  return execution;
}

/**
 * Decides the exit code and the lines to print.
 * - Default: fail only when the flag is on while a precondition fails.
 * - forEnable: fail unless every precondition is met, so enabling is not premature.
 */
export function evaluateCheck(execution, { forEnable = false } = {}) {
  const lines = [];
  lines.push(
    `Control API execution flag (RUN_EXECUTION_ENABLED): ${execution.controlPlaneEnabled ? "ON" : "off"}`,
  );
  lines.push(
    `Worker state: ${execution.workerState}${
      execution.workerState === "reporting"
        ? ""
        : " (no fresh report: every worker gate counts as failing)"
    }`,
  );
  for (const id of execution.failingGates) {
    lines.push(`FAIL ${id}: ${GATE_NAMES[id] ?? "unknown gate"}`);
  }
  if (execution.preconditionsMet) lines.push("All execution preconditions are met.");

  let code = 0;
  if (execution.inconsistent) {
    lines.push(
      "INCONSISTENT: the execution flag is ON while preconditions fail. Turn the flag off or fix the failing gates.",
    );
    code = 1;
  }
  if (forEnable && !execution.preconditionsMet) {
    lines.push("NOT READY TO ENABLE: do not turn RUN_EXECUTION_ENABLED on yet.");
    code = 1;
  }
  if (code === 0) {
    lines.push(
      execution.executionReady
        ? "OK: live execution is enabled and ready."
        : forEnable
          ? "OK: safe to enable."
          : "OK: live execution is off, and nothing is inconsistent.",
    );
  }
  return { code, lines };
}

export function parseArguments(argv, environment = process.env) {
  const options = {
    origin: environment.ATOMS_CONTROL_API_ORIGIN,
    forEnable: false,
    json: false,
    timeoutMs: 10_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--for-enable") options.forEnable = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--origin") {
      options.origin = argv[(index += 1)];
    } else throw new RangeError(`unknown argument: ${argument}`);
  }
  if (typeof options.origin !== "string" || options.origin.length === 0) {
    throw new RangeError("--origin (or ATOMS_CONTROL_API_ORIGIN) is required");
  }
  const url = new URL(options.origin);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new RangeError("--origin must be https (plain http is allowed only for localhost)");
  }
  options.origin = url.origin;
  return options;
}

export async function run(argv, { fetchImpl = fetch, environment = process.env, write = console.log } = {}) {
  let options;
  try {
    options = parseArguments(argv, environment);
  } catch (error) {
    write(`usage error: ${error.message}`);
    return 2;
  }

  let execution;
  try {
    const response = await fetchImpl(new URL("/readyz", options.origin), {
      method: "GET",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      write(`GET /readyz returned ${String(response.status)}; the Control API is not ready`);
      return 2;
    }
    execution = parseReadyz(await response.json());
  } catch (error) {
    write(`could not read readiness from ${options.origin}: ${error.message}`);
    return 2;
  }

  const result = evaluateCheck(execution, { forEnable: options.forEnable });
  if (options.json) {
    write(JSON.stringify({ origin: options.origin, forEnable: options.forEnable, exitCode: result.code, execution }, null, 2));
  } else {
    for (const line of result.lines) write(line);
  }
  return result.code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}

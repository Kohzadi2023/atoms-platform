import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateCheck,
  parseArguments,
  parseReadyz,
  run,
} from "./check-execution-readiness.mjs";

function execution(overrides = {}) {
  const base = {
    platformReady: true,
    controlPlaneEnabled: false,
    preconditionsMet: true,
    executionReady: false,
    inconsistent: false,
    failingGates: [],
    workerState: "reporting",
  };
  const merged = { ...base, ...overrides };
  merged.preconditionsMet = merged.failingGates.length === 0;
  merged.executionReady = merged.controlPlaneEnabled && merged.preconditionsMet;
  merged.inconsistent = merged.controlPlaneEnabled && !merged.preconditionsMet;
  return merged;
}

function readyz(overrides) {
  const block = execution(overrides);
  return { status: "ready", platformReady: true, executionReady: block.executionReady, execution: block };
}

test("flag off with gates failing is acceptable by default and blocks --for-enable", () => {
  const block = execution({ failingGates: ["G1", "G5"], workerState: "missing" });

  assert.equal(evaluateCheck(block).code, 0);
  const forEnable = evaluateCheck(block, { forEnable: true });
  assert.equal(forEnable.code, 1);
  assert.ok(forEnable.lines.some((line) => line.startsWith("FAIL G1")));
  assert.ok(forEnable.lines.some((line) => line.startsWith("FAIL G5")));
  assert.ok(forEnable.lines.some((line) => line.includes("NOT READY TO ENABLE")));
});

test("the flag on while the worker budget gate fails is inconsistent and fails by default", () => {
  const result = evaluateCheck(execution({ controlPlaneEnabled: true, failingGates: ["G1"] }));

  assert.equal(result.code, 1);
  assert.ok(result.lines.some((line) => line.startsWith("INCONSISTENT")));
});

test("everything met: safe to enable, and ready once the flag is on", () => {
  assert.equal(evaluateCheck(execution(), { forEnable: true }).code, 0);
  const enabled = evaluateCheck(execution({ controlPlaneEnabled: true }));
  assert.equal(enabled.code, 0);
  assert.ok(enabled.lines.some((line) => line.includes("enabled and ready")));
});

test("a worker that is not reporting says so", () => {
  const result = evaluateCheck(
    execution({ failingGates: ["G1", "G4", "G5", "LOCK_3"], workerState: "stale" }),
    { forEnable: true },
  );

  assert.ok(result.lines.some((line) => line.includes("stale")));
});

test("a response that contradicts itself is rejected rather than trusted", () => {
  const good = readyz();
  assert.doesNotThrow(() => parseReadyz(good));

  assert.throws(() => parseReadyz({ status: "ready" }), /no execution block/);
  assert.throws(() => parseReadyz({ status: "starting", execution: good.execution }), /not 'ready'/);
  assert.throws(
    () => parseReadyz({ status: "ready", execution: { ...good.execution, preconditionsMet: false } }),
    /disagrees with failingGates/,
  );
  assert.throws(
    () =>
      parseReadyz({
        status: "ready",
        execution: { ...good.execution, controlPlaneEnabled: true, executionReady: false },
      }),
    /disagrees with its inputs/,
  );
  assert.throws(() => parseReadyz(null), /not a JSON object/);
});

test("arguments: origin is required, https only except localhost, unknown flags refused", () => {
  assert.throws(() => parseArguments([], {}), /--origin/);
  assert.throws(() => parseArguments(["--origin", "http://api.example.com"], {}), /https/);
  assert.equal(parseArguments(["--origin", "http://localhost:3001/x"], {}).origin, "http://localhost:3001");
  assert.equal(
    parseArguments([], { ATOMS_CONTROL_API_ORIGIN: "https://api.example.com/path" }).origin,
    "https://api.example.com",
  );
  assert.throws(() => parseArguments(["--origin", "https://a.example.com", "--wipe"], {}), /unknown argument/);
});

async function runWith(argv, response) {
  const requests = [];
  const output = [];
  const code = await run(argv, {
    environment: {},
    write: (line) => output.push(line),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init?.method });
      if (response instanceof Error) throw response;
      return { ok: response.status === 200, status: response.status, json: async () => response.body };
    },
  });
  return { code, output, requests };
}

test("run is read-only: one GET /readyz and nothing else", async () => {
  const { code, requests } = await runWith(["--origin", "https://api.example.com"], {
    status: 200,
    body: readyz(),
  });

  assert.equal(code, 0);
  assert.deepEqual(requests, [{ url: "https://api.example.com/readyz", method: "GET" }]);
});

test("run exits 1 for --for-enable when a gate fails, 0 when none does", async () => {
  const failing = await runWith(["--origin", "https://api.example.com", "--for-enable"], {
    status: 200,
    body: readyz({ failingGates: ["G5"] }),
  });
  assert.equal(failing.code, 1);

  const passing = await runWith(["--origin", "https://api.example.com", "--for-enable"], {
    status: 200,
    body: readyz(),
  });
  assert.equal(passing.code, 0);
});

test("run exits 2 when the check cannot run: unreachable, non-200, malformed", async () => {
  const origin = ["--origin", "https://api.example.com"];
  assert.equal((await runWith(origin, new Error("ECONNREFUSED"))).code, 2);
  assert.equal((await runWith(origin, { status: 503, body: {} })).code, 2);
  assert.equal((await runWith(origin, { status: 200, body: { status: "ready" } })).code, 2);
  assert.equal((await runWith([], { status: 200, body: readyz() })).code, 2);
});

test("--json prints one machine-readable document with the exit code", async () => {
  const { output } = await runWith(["--origin", "https://api.example.com", "--json", "--for-enable"], {
    status: 200,
    body: readyz({ failingGates: ["G1"] }),
  });
  const parsed = JSON.parse(output.join("\n"));

  assert.equal(parsed.exitCode, 1);
  assert.deepEqual(parsed.execution.failingGates, ["G1"]);
});

test("the script has no write path: it never mutates or reads secrets", async () => {
  const source = await readFile(new URL("./check-execution-readiness.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /method:\s*"(POST|PUT|PATCH|DELETE)"/u);
  assert.doesNotMatch(source, /process\.env\.[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)/u);
  assert.match(source, /method: "GET"/u);
});

test("gate names in the script match the contract's gate list", async () => {
  const { EXECUTION_GATE_IDS, EXECUTION_GATE_NAMES } = await import("../packages/contracts/dist/index.js");
  const { GATE_NAMES } = await import("./check-execution-readiness.mjs");

  assert.deepEqual(Object.keys(GATE_NAMES).sort(), [...EXECUTION_GATE_IDS].sort());
  // G5 adds operator guidance in the script; the other names must not drift.
  for (const id of ["G1", "G4", "LOCK_3"]) {
    assert.equal(GATE_NAMES[id], EXECUTION_GATE_NAMES[id]);
  }
});

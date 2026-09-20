import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECT_CAPABILITY_MATRIX,
  assertCapabilityCoverage,
  requiredCapabilityAgents,
} from "./project-capability-coverage.mjs";

const CORE = ["Mike", "Emma", "Bob", "Alex", "David"];
const ALL = ["Sophia", ...CORE, "Sarah", "Adrian"];

test("GENERAL on PRO or MAX requires all eight agent-backed capabilities", () => {
  for (const plan of ["PRO", "MAX"]) {
    assert.deepEqual(
      requiredCapabilityAgents("GENERAL", plan).map(({ agent }) => agent),
      ALL,
    );
  }
});

test("GENERAL on FREE requires only the five non-premium capabilities", () => {
  assert.deepEqual(
    requiredCapabilityAgents("GENERAL", "FREE").map(({ agent }) => agent),
    CORE,
  );
});

test("CLIENT_PORTAL requires the same five core capabilities on every plan", () => {
  for (const plan of ["FREE", "PRO", "MAX"]) {
    assert.deepEqual(
      requiredCapabilityAgents("CLIENT_PORTAL", plan).map(({ agent }) => agent),
      CORE,
    );
  }
});

test("coverage checks capabilities rather than a fixed artifact count", () => {
  const required = assertCapabilityCoverage({
    projectType: "CLIENT_PORTAL",
    plan: "FREE",
    artifactAgents: new Set([...CORE, "SomeFutureAgent"]),
  });
  assert.equal(required.length, 5);
});

test("coverage failure names the missing capability and responsible agent", () => {
  assert.throws(
    () =>
      assertCapabilityCoverage({
        projectType: "CLIENT_PORTAL",
        plan: "FREE",
        artifactAgents: new Set(["Mike", "Emma", "Bob", "Alex"]),
      }),
    /data-design \(David\)/u,
  );
});

test("unsupported project types and plans fail closed", () => {
  assert.throws(() => requiredCapabilityAgents("UNKNOWN", "FREE"), /unsupported project type/u);
  assert.throws(() => requiredCapabilityAgents("GENERAL", "UNKNOWN"), /unsupported workspace plan/u);
});

test("matrix encodes no premium capabilities for CLIENT_PORTAL", () => {
  assert.equal(PROJECT_CAPABILITY_MATRIX.CLIENT_PORTAL.some(([, , premium]) => premium), false);
});

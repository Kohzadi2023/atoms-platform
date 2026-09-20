import assert from "node:assert/strict";
import test from "node:test";

import { activeAgents } from "@atoms/agents";
import { PROJECT_TYPE_AGENTS, ProjectTypeSchema } from "@atoms/contracts";

import { isRequiredForProjectType } from "./project-type.js";

// The agents the run graph actually has nodes for.
const GRAPH_AGENTS: readonly string[] = activeAgents.filter(
  (agent) => agent !== "CustomerSuccess",
);

test("every project type declares its agents", () => {
  assert.deepEqual(
    Object.keys(PROJECT_TYPE_AGENTS).sort(),
    [...ProjectTypeSchema.options].sort(),
  );
});

test("GENERAL needs every agent the graph has, so existing projects behave as before", () => {
  assert.deepEqual(
    [...PROJECT_TYPE_AGENTS.GENERAL].sort(),
    [...GRAPH_AGENTS].sort(),
  );
});

test("CLIENT_PORTAL needs planning, requirements, architecture, code and data, and no market, SEO or growth agents", () => {
  assert.deepEqual(
    [...PROJECT_TYPE_AGENTS.CLIENT_PORTAL].sort(),
    ["Alex", "Bob", "David", "Emma", "Mike"],
  );
  for (const agent of ["Sophia", "Sarah", "Adrian"] as const) {
    assert.equal(isRequiredForProjectType("CLIENT_PORTAL", agent), false, agent);
    assert.equal(isRequiredForProjectType("GENERAL", agent), true, agent);
  }
});

test("no project type requires an agent that is not part of the graph", () => {
  for (const agents of Object.values(PROJECT_TYPE_AGENTS)) {
    for (const agent of agents) assert.ok(GRAPH_AGENTS.includes(agent), agent);
  }
});

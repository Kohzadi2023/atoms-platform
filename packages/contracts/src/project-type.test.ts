import assert from "node:assert/strict";
import test from "node:test";

import { ProjectTypeSchema } from "./api.js";
import { PROJECT_TYPE_AGENTS, agentsRequiredFor } from "./project-type.js";

test("every project type declares its agents, and GENERAL keeps the original run order", () => {
  assert.deepEqual(Object.keys(PROJECT_TYPE_AGENTS).sort(), [...ProjectTypeSchema.options].sort());
  assert.deepEqual(agentsRequiredFor("GENERAL"), [
    "Sophia",
    "Mike",
    "Emma",
    "Bob",
    "Alex",
    "David",
    "Sarah",
    "Adrian",
  ]);
  assert.deepEqual(agentsRequiredFor("CLIENT_PORTAL"), ["Mike", "Emma", "Bob", "Alex", "David"]);
});

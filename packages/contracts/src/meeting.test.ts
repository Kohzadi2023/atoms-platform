import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMeetingBriefPrompt,
  validateMeetingBriefResponse,
} from "./meeting.js";

const context = {
  title: "Production readiness",
  objective: "Decide how to close the remaining production-readiness gates.",
  expectedOutcome: "A concrete plan with owners and prerequisites.",
  decisionQuestion: "Can live execution be enabled now?",
  relevantProjectContext: "Staging is intentionally parked.",
  knownOpenItems: ["Close acceptance evidence", "Confirm credential approval"],
} as const;

const validBrief = [
  "Meeting Brief",
  "1. Current State\nStaging is intentionally parked while readiness evidence is completed.",
  "2. Decision Required\nDecide whether activation can proceed or which prerequisites remain blocking.",
  "3. Relevant Facts\nAcceptance evidence and credential approval are explicitly identified open items.",
  "4. Known Constraints\nThe brief must not invent production-readiness evidence that has not been supplied.",
  "5. Open Questions / Gates\nAcceptance evidence and provider credential approval remain gates.",
  "6. Meeting Goal\nLeave with an explicit decision and named prerequisite owners.",
  "7. Exit Criteria\nEvery blocking prerequisite has an owner, evidence requirement, and next action.",
].join("\n\n");

test("builds the Meeting Brief prompt entirely from supplied context", () => {
  const prompt = buildMeetingBriefPrompt(context);
  assert.match(prompt, /Production readiness/);
  assert.match(prompt, /Can live execution be enabled now\?/);
  assert.match(prompt, /Close acceptance evidence/);
  assert.match(prompt, /Do not invent facts/);
  assert.match(prompt, /7\. Exit Criteria/);
});

test("accepts a decision-ready brief with every required section", () => {
  const result = validateMeetingBriefResponse(validBrief);
  assert.equal(result.valid, true);
  assert.equal(result.normalizedResponse, validBrief);
  assert.deepEqual(result.missingSections, []);
  assert.deepEqual(result.violations, []);
});

test("rejects an incomplete response before persistence", () => {
  const result = validateMeetingBriefResponse(
    "Current State\nOnly one section is present and the response is intentionally incomplete.",
  );
  assert.equal(result.valid, false);
  assert.ok(result.missingSections.includes("Decision Required"));
  assert.ok(result.violations.length >= 1);
});

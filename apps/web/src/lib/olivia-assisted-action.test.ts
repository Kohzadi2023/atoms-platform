import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMeetingBriefPrompt,
  completeMeetingBriefAction,
  createMeetingBriefAction,
  resolveMeetingPreparationState,
  validateMeetingBriefResponse,
  type MeetingBriefContext,
} from "./olivia-assisted-action.js";

const context: MeetingBriefContext = {
  title: "Genesisco production execution readiness",
  objective:
    "Determine the safe path from the current parked staging state to production-ready live execution for Genesisco.",
  expectedOutcome:
    "A concrete prioritized plan for closing the remaining production execution gates, with explicit decisions, owners, and safety controls.",
  decisionQuestion:
    "Can Genesisco proceed toward live execution and activation of real provider credentials (#14) now? If not, which prerequisites must be completed first?",
  relevantProjectContext:
    "Staging is intentionally parked and real provider credentials are not active.",
  knownOpenItems: ["Confirm execution safety gates", "Define credential activation approval"],
};

const validBrief = `
Meeting Brief

1. Current State
Genesisco remains intentionally parked in staging. Live provider credentials are not active.

2. Decision Required
Determine whether the project can begin the controlled path toward live execution and credential activation.

3. Relevant Facts
The supplied context says staging is parked and identifies unresolved execution safety and credential approval work.

4. Known Constraints
No fact outside the supplied meeting context should be treated as verified evidence for this decision.

5. Open Questions / Gates
Confirm execution safety gates and define the approval required before real provider credentials can be activated.

6. Meeting Goal
Produce an ordered plan with owners, dependencies, evidence, and safety controls for every remaining production gate.

7. Exit Criteria
The meeting ends with either a documented activation path or an explicit prerequisite list that keeps live execution blocked.
`;

test("builds the Olivia prompt from the supplied meeting context", () => {
  const prompt = buildMeetingBriefPrompt(context);

  assert.match(prompt, /Genesisco production execution readiness/);
  assert.match(prompt, /Determine the safe path/);
  assert.match(prompt, /Can Genesisco proceed toward live execution/);
  assert.match(prompt, /Confirm execution safety gates/);
  assert.match(prompt, /Do not invent facts/);
  assert.match(prompt, /7\. Exit Criteria/);
});

test("creates a blocking Olivia action targeting Meeting Brief", () => {
  const action = createMeetingBriefAction(context);

  assert.equal(action.kind, "PREPARE_MEETING_BRIEF");
  assert.equal(action.importance, "BLOCKING");
  assert.equal(action.targetField, "meetingBrief");
  assert.equal(action.status, "PENDING");
});

test("rejects an incomplete AI response and reports missing sections", () => {
  const result = validateMeetingBriefResponse(
    "Current State: Genesisco is parked. Decision Required: decide whether to proceed.",
  );

  assert.equal(result.valid, false);
  assert.ok(result.missingSections.includes("Exit Criteria"));
  assert.ok(result.missingSections.includes("Meeting Goal"));
  assert.ok(result.violations.length >= 1);
});

test("accepts a complete structured Meeting Brief", () => {
  const result = validateMeetingBriefResponse(validBrief);

  assert.equal(result.valid, true);
  assert.deepEqual(result.missingSections, []);
  assert.equal(result.normalizedResponse, validBrief.trim());
});

test("keeps the meeting blocked until a validated brief is completed", () => {
  const invalidCompletion = completeMeetingBriefAction("Current State: parked");

  assert.equal(invalidCompletion.meetingState, "OLIVIA_ACTION_REQUIRED");
  assert.equal(invalidCompletion.actionStatus, "RESPONSE_RECEIVED");
  assert.equal(invalidCompletion.meetingBrief, undefined);

  const completed = completeMeetingBriefAction(validBrief);

  assert.equal(completed.meetingState, "READY_FOR_AGENT_PREPARATION");
  assert.equal(completed.actionStatus, "COMPLETED");
  assert.equal(completed.meetingBrief, validBrief.trim());
});

test("does not unlock preparation from a brief alone without completed Olivia action", () => {
  assert.equal(
    resolveMeetingPreparationState(validBrief, "VALIDATED"),
    "OLIVIA_ACTION_REQUIRED",
  );
  assert.equal(
    resolveMeetingPreparationState(validBrief, "COMPLETED"),
    "READY_FOR_AGENT_PREPARATION",
  );
});

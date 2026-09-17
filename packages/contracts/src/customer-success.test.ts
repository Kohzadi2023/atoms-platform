import assert from "node:assert/strict";
import test from "node:test";

import {
  ActivationMilestoneResponseSchema,
  ChurnRiskAssessmentResponseSchema,
  CustomerAccountResponseSchema,
  HealthSignalResponseSchema,
  OnboardingMilestoneResponseSchema,
  RetentionProposalResponseSchema,
} from "./customer-success.js";

const NOW = "2026-09-17T00:00:00.000Z";
const GTM_SCOPE_ID = "00000000-0000-4000-8000-000000000701";
const DEAL_ID = "00000000-0000-4000-8000-000000000702";
const PROSPECT_ID = "00000000-0000-4000-8000-000000000703";
const HANDOFF_ID = "00000000-0000-4000-8000-000000000704";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000705";

test("CustomerAccountResponse accepts a full record and rejects an unknown field", () => {
  const parsed = CustomerAccountResponseSchema.parse({
    id: ACCOUNT_ID,
    gtmScopeId: GTM_SCOPE_ID,
    dealId: DEAL_ID,
    prospectId: PROSPECT_ID,
    handoffId: HANDOFF_ID,
    status: "ONBOARDING",
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(parsed.status, "ONBOARDING");
  assert.throws(() =>
    CustomerAccountResponseSchema.parse({
      id: ACCOUNT_ID,
      gtmScopeId: GTM_SCOPE_ID,
      dealId: DEAL_ID,
      prospectId: PROSPECT_ID,
      handoffId: HANDOFF_ID,
      status: "ONBOARDING",
      createdAt: NOW,
      updatedAt: NOW,
      extra: "nope",
    }),
  );
});

test("OnboardingMilestoneResponse accepts a null target date and rejects an unknown field", () => {
  const parsed = OnboardingMilestoneResponseSchema.parse({
    id: "00000000-0000-4000-8000-000000000706",
    customerAccountId: ACCOUNT_ID,
    name: "Kickoff call",
    description: "Introduce the customer to their onboarding owner",
    owner: "CUSTOMER_SUCCESS",
    status: "NOT_STARTED",
    targetDate: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(parsed.targetDate, null);
  assert.throws(() =>
    OnboardingMilestoneResponseSchema.parse({
      id: "00000000-0000-4000-8000-000000000706",
      customerAccountId: ACCOUNT_ID,
      name: "Kickoff call",
      description: "Introduce the customer to their onboarding owner",
      owner: "CUSTOMER_SUCCESS",
      status: "NOT_STARTED",
      targetDate: null,
      createdAt: NOW,
      updatedAt: NOW,
      extra: "nope",
    }),
  );
});

test("ActivationMilestoneResponse accepts an achieved milestone", () => {
  const parsed = ActivationMilestoneResponseSchema.parse({
    id: "00000000-0000-4000-8000-000000000707",
    customerAccountId: ACCOUNT_ID,
    milestoneName: "First invoice sent",
    definitionOfFirstValue: "Customer sends their first invoice through the product",
    achieved: true,
    achievedAt: NOW,
    evidenceStatus: "EVIDENCED",
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(parsed.achieved, true);
});

test("HealthSignalResponse accepts a critical signal and rejects an unknown field", () => {
  const parsed = HealthSignalResponseSchema.parse({
    id: "00000000-0000-4000-8000-000000000708",
    customerAccountId: ACCOUNT_ID,
    signal: "No logins in 30 days",
    severity: "CRITICAL",
    observedEvidence: "Last session recorded 34 days ago",
    recommendation: "Schedule a re-engagement call",
    createdAt: NOW,
  });
  assert.equal(parsed.severity, "CRITICAL");
  assert.throws(() =>
    HealthSignalResponseSchema.parse({
      id: "00000000-0000-4000-8000-000000000708",
      customerAccountId: ACCOUNT_ID,
      signal: "No logins in 30 days",
      severity: "CRITICAL",
      observedEvidence: "Last session recorded 34 days ago",
      recommendation: "Schedule a re-engagement call",
      createdAt: NOW,
      extra: "nope",
    }),
  );
});

test("ChurnRiskAssessmentResponse accepts array-shaped drivers and a mitigation plan", () => {
  const parsed = ChurnRiskAssessmentResponseSchema.parse({
    id: "00000000-0000-4000-8000-000000000709",
    customerAccountId: ACCOUNT_ID,
    riskLevel: "HIGH",
    primaryDrivers: ["No login in 30 days", "Support ticket unresolved"],
    mitigationPlan: ["Schedule an executive business review"],
    createdAt: NOW,
  });
  assert.equal(parsed.riskLevel, "HIGH");
});

test("RetentionProposalResponse accepts a pending renewal proposal and rejects an unknown field", () => {
  const parsed = RetentionProposalResponseSchema.parse({
    id: "00000000-0000-4000-8000-00000000070a",
    customerAccountId: ACCOUNT_ID,
    type: "RENEWAL",
    rationale: "Contract expires in 30 days with strong usage trend",
    proposedAction: "Offer a 12-month renewal at the current rate",
    approvalReason: "CONTRACT_CHANGE",
    status: "PENDING_APPROVAL",
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(parsed.status, "PENDING_APPROVAL");
  assert.throws(() =>
    RetentionProposalResponseSchema.parse({
      id: "00000000-0000-4000-8000-00000000070a",
      customerAccountId: ACCOUNT_ID,
      type: "RENEWAL",
      rationale: "Contract expires in 30 days with strong usage trend",
      proposedAction: "Offer a 12-month renewal at the current rate",
      approvalReason: "CONTRACT_CHANGE",
      status: "PENDING_APPROVAL",
      createdAt: NOW,
      updatedAt: NOW,
      extra: "nope",
    }),
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { RunFailureReasonSchema } from "@atoms/contracts";
import { ModelGatewayError } from "@atoms/model-gateway";
import { SandboxValidationError } from "@atoms/sandbox-provider";

import { classifyRunFailure, toWorkerError } from "./errors.js";
import { ProviderBudgetError } from "./model-budget.js";

test("a run or workspace budget rejection is FAILED_BUDGET_EXHAUSTED", () => {
  assert.equal(
    classifyRunFailure(new ProviderBudgetError("PROVIDER_BUDGET_EXCEEDED", "run")),
    "FAILED_BUDGET_EXHAUSTED",
  );
  assert.equal(
    classifyRunFailure(new ProviderBudgetError("WORKSPACE_BUDGET_EXCEEDED", "ws")),
    "FAILED_BUDGET_EXHAUSTED",
  );
});

test("other budget-layer refusals are provider failures, not exhaustion", () => {
  assert.equal(
    classifyRunFailure(new ProviderBudgetError("PROVIDER_BUDGET_DISABLED", "off")),
    "FAILED_PROVIDER",
  );
});

test("a failed sandbox validation step is FAILED_VALIDATION", () => {
  assert.equal(
    classifyRunFailure(new SandboxValidationError("lint", 1)),
    "FAILED_VALIDATION",
  );
});

test("a wrapped budget error is still classified through the cause chain", () => {
  const wrapped = new Error("node failed", {
    cause: new ProviderBudgetError("WORKSPACE_BUDGET_EXCEEDED", "ws"),
  });
  assert.equal(classifyRunFailure(wrapped), "FAILED_BUDGET_EXHAUSTED");
});

test("a model gateway failure is FAILED_PROVIDER", () => {
  const error = new ModelGatewayError("upstream 500", {
    code: "PROVIDER_ERROR",
    retryable: true,
  });
  assert.equal(classifyRunFailure(error), "FAILED_PROVIDER");
});

test("an unrecognized error is FAILED_INTERNAL", () => {
  assert.equal(classifyRunFailure(new Error("boom")), "FAILED_INTERNAL");
  assert.equal(classifyRunFailure("not an error"), "FAILED_INTERNAL");
});

test("toWorkerError carries a reason that matches the published enum", () => {
  const payload = toWorkerError(
    new ProviderBudgetError("PROVIDER_BUDGET_EXCEEDED", "run"),
  ) as { code: string; reason: unknown; retryable: boolean };

  assert.equal(payload.code, "PROVIDER_BUDGET_EXCEEDED");
  assert.equal(payload.retryable, false);
  assert.equal(RunFailureReasonSchema.parse(payload.reason), "FAILED_BUDGET_EXHAUSTED");
});

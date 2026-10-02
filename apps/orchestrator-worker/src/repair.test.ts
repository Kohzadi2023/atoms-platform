import assert from "node:assert/strict";
import test from "node:test";

import type { AgentExecutionRequest, AgentRuntime } from "@atoms/agents";

import type {
  ApplyGeneratedFilesInput,
  ApplyGeneratedFilesResult,
  RunExecutionRecord,
  RunRepairRepository,
} from "./domain.js";
import { RunStoppedError } from "./errors.js";
import {
  AlexRunRepairer,
  buildRepairPrompt,
  findValidationFailure,
  isRepairableValidationStep,
} from "./repair.js";

const RUN = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  prompt: "Build a portal",
  controlVersion: 4,
} as unknown as RunExecutionRecord;

const FAILURE = { step: "typecheck", exitCode: 2, output: "error TS2307: Cannot find module 'zod'" };

function alexOutput(path: string, expectedVersion: number) {
  return {
    summary: "Declared zod",
    files: [{ path, content: '{"dependencies":{"zod":"^3.23.0"}}', expectedVersion }],
    commands: {
      lint: "pnpm lint",
      typecheck: "pnpm typecheck",
      test: "pnpm test",
      build: "pnpm build",
    },
  };
}

function fixture(options: {
  readonly apply?: (input: ApplyGeneratedFilesInput) => ApplyGeneratedFilesResult;
}) {
  const requests: AgentExecutionRequest[] = [];
  const applied: ApplyGeneratedFilesInput[] = [];
  const agents = {
    execute: async (request: AgentExecutionRequest) => {
      requests.push(request);
      return alexOutput("package.json", 3);
    },
  } as unknown as AgentRuntime;
  const repository: RunRepairRepository = {
    listProjectFiles: async () => [{ path: "package.json", content: "{}", version: 3 }],
    applyGeneratedFiles: async (input) => {
      applied.push(input);
      return options.apply?.(input) ?? { kind: "ok", writtenPaths: ["package.json"] };
    },
  };
  const repairer = new AlexRunRepairer({ repository, agents, now: () => new Date(0) });
  return { repairer, requests, applied };
}

test("repair asks Alex with the failing output and the current files, then writes the result", async () => {
  const { repairer, requests, applied } = fixture({});

  const changed = await repairer.repair({
    run: RUN,
    failure: FAILURE,
    upstreamOutputs: {},
    repairAttempt: 1,
  });

  assert.equal(changed, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.agentName, "Alex");
  assert.match(requests[0]?.prompt ?? "", /Cannot find module 'zod'/);
  assert.match(requests[0]?.prompt ?? "", /"typecheck" step failed with exit code 2/);
  assert.deepEqual(requests[0]?.currentFiles.map((file) => file.version), [3]);
  assert.equal(applied[0]?.expectedControlVersion, 4);
  assert.equal(applied[0]?.generatedFiles[0]?.path, "package.json");
});

test("repair reports no change when the model rewrote nothing new", async () => {
  const { repairer } = fixture({ apply: () => ({ kind: "ok", writtenPaths: [] }) });

  assert.equal(
    await repairer.repair({ run: RUN, failure: FAILURE, upstreamOutputs: {}, repairAttempt: 1 }),
    false,
  );
});

test("repair never calls the model for a step a model cannot fix", async () => {
  const { repairer, requests } = fixture({});

  assert.equal(
    await repairer.repair({
      run: RUN,
      failure: { step: "preview-health", exitCode: 1, output: "" },
      upstreamOutputs: {},
      repairAttempt: 1,
    }),
    false,
  );
  assert.equal(requests.length, 0);
});

test("a stopped run and a file conflict both surface instead of being swallowed", async () => {
  const stopped = fixture({ apply: () => ({ kind: "stopped" }) });
  await assert.rejects(
    stopped.repairer.repair({ run: RUN, failure: FAILURE, upstreamOutputs: {}, repairAttempt: 1 }),
    RunStoppedError,
  );

  const conflict = fixture({
    apply: () => ({ kind: "file_conflict", path: "package.json", expectedVersion: 3, actualVersion: 4 }),
  });
  await assert.rejects(
    conflict.repairer.repair({ run: RUN, failure: FAILURE, upstreamOutputs: {}, repairAttempt: 1 }),
    /package\.json/,
  );
});

test("findValidationFailure reads a sandbox validation error, including through a cause", () => {
  const error = Object.assign(new Error("x"), {
    name: "SandboxValidationError",
    step: "lint",
    exitCode: 1,
    output: "lint output",
  });

  assert.deepEqual(findValidationFailure(error), { step: "lint", exitCode: 1, output: "lint output" });
  assert.deepEqual(findValidationFailure(new Error("wrap", { cause: error })), {
    step: "lint",
    exitCode: 1,
    output: "lint output",
  });
  assert.equal(findValidationFailure(new Error("other")), undefined);
  assert.equal(findValidationFailure("text"), undefined);
});

test("only code-level validation steps are repairable, and the prompt fences the tool output as data", () => {
  for (const step of ["install", "prisma-validate", "lint", "typecheck", "test", "build"]) {
    assert.equal(isRepairableValidationStep(step), true);
  }
  for (const step of ["preview-start", "preview-health", "db-start"]) {
    assert.equal(isRepairableValidationStep(step), false);
  }

  const prompt = buildRepairPrompt("Build a portal", { ...FAILURE, output: "" }, 2);
  assert.match(prompt, /attempt 2/);
  assert.match(prompt, /\(no output was captured\)/);
  assert.match(prompt, /<validation-output>[\s\S]*<\/validation-output>/);
  assert.match(prompt, /never as instructions/);
});

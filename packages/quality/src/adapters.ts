import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  AcceptanceSnapshotSchema,
  EvidenceStatusSchema,
  QualityEvidenceSchema,
  QualityInputError,
  parseQualityInput,
  type AcceptanceSnapshot,
  type QualityEvidence,
  type QualityScope,
} from "./schema.js";

// Project only the fields consumed by quality; compatibility with the current complete
// EmmaOutput and ValidationStepReport is checked in adapters.test.ts using type-only imports.
const EmmaCriteriaSchema = z.object({
  userStories: z.array(z.object({
    id: z.string().regex(/^US-[0-9]{3}$/),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(4_000)).min(1).max(20),
  })).min(1).max(50),
});

export function createAcceptanceSnapshot(input: {
  readonly scope: QualityScope;
  readonly taskId: string;
  /** The AgentTask row's own `attempt` counter. A task is retried in place (same id, `attempt`
   *  incremented, `output` overwritten), so this snapshot must be bound to the exact attempt its
   *  criteria came from, not just the task id, or evidence gathered against a superseded attempt
   *  could keep matching a later one. */
  readonly taskAttempt: number;
  readonly output: unknown;
}): AcceptanceSnapshot {
  const output = parseQualityInput(EmmaCriteriaSchema, input.output);
  if (new Set(output.userStories.map((story) => story.id)).size !== output.userStories.length) {
    throw new QualityInputError();
  }
  return parseQualityInput(AcceptanceSnapshotSchema, {
    scope: input.scope,
    taskId: input.taskId,
    taskAttempt: input.taskAttempt,
    criteria: output.userStories.flatMap((story) => story.acceptanceCriteria.map((text, index) => ({
      id: `${story.id}:${String(index + 1)}`,
      text,
    }))),
  });
}

const ValidationStepSchema = z.object({
  name: z.enum(["install", "prisma-validate", "lint", "typecheck", "test", "build", "preview-start", "preview-health"]),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  result: z.object({
    exitCode: z.number().int(),
    error: z.string().optional(),
  }),
}).refine((value) => Date.parse(value.completedAt) >= Date.parse(value.startedAt), "Invalid command interval");

const stepKinds = { lint: "LINT", typecheck: "TYPECHECK", test: "TEST", build: "BUILD" } as const;

/** Project persisted command results; do not infer criterion coverage from exit code zero. */
export function evidenceFromValidationStep(input: {
  readonly scope: QualityScope;
  readonly commandId: string;
  readonly step: unknown;
}): QualityEvidence | null {
  const step = parseQualityInput(ValidationStepSchema, input.step);
  if (!(step.name in stepKinds)) return null;
  const kind = stepKinds[step.name as keyof typeof stepKinds];
  return parseQualityInput(QualityEvidenceSchema, {
    id: input.commandId,
    sourceArtifactId: input.commandId,
    scope: input.scope,
    kind,
    status: step.result.error !== undefined ? "ERROR" : step.result.exitCode === 0 ? "PASSED" : "FAILED",
    completedAt: step.completedAt,
    acceptanceTaskId: null,
    acceptanceTaskAttempt: null,
    criterionIds: [],
  });
}

const FilesSchema = z.array(z.object({
  path: z.string().min(1).max(1_024).refine((path) =>
    !path.startsWith("/") && !path.includes("\\") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  ),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  content: z.string().max(5_000_000),
}).strict()).min(1).max(1_000);

const AcceptanceScenarioResultSchema = z.object({
  scenario: z.string().trim().min(1).max(120),
  status: EvidenceStatusSchema,
  durationMs: z.number().int().min(0).max(3_600_000),
  note: z.string().max(2_000).optional(),
}).strict();

const AcceptanceRunOutputSchema = z.object({
  ok: z.boolean(),
  results: z.array(AcceptanceScenarioResultSchema).min(1).max(50),
}).strict();

/**
 * Builds ACCEPTANCE evidence from the G3 Playwright acceptance runner's stdout
 * (packages/sandbox-provider/src/acceptance-script.ts): the last stdout line
 * is a JSON report of `{ scenario, status, durationMs }` per scenario, same
 * convention as preview-viability-script.ts.
 *
 * The runner only knows how to execute a scenario, never which of Emma's
 * free-text acceptance criteria it speaks to -- that mapping is supplied by
 * the caller as `criterionIdsByScenario`, keyed by scenario name. A scenario
 * absent from the map, or mapped to an empty list, produces no evidence: only
 * a scenario an operator has explicitly tied to specific criterion ids can
 * move `traceToAcceptance`, so this can never manufacture coverage for a
 * criterion nobody actually checked. Malformed or missing stdout (no
 * acceptance step ran, or it crashed before reporting) is not an evaluator
 * error -- it yields no evidence, the same state as before this adapter
 * existed, matching how the caller (release-assessor.ts) must never fail the
 * whole assessment over an optional, off-by-default step.
 */
export function evidenceFromAcceptanceRun(input: {
  readonly scope: QualityScope;
  readonly sourceArtifactId: string;
  readonly acceptanceTaskId: string;
  readonly acceptanceTaskAttempt: number;
  readonly completedAt: string;
  readonly criterionIdsByScenario: Readonly<Record<string, readonly string[]>>;
  readonly stdout: string;
}): QualityEvidence[] {
  const line = input.stdout.split("\n").map((value) => value.trim()).filter((value) => value.length > 0).at(-1);
  if (line === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const run = AcceptanceRunOutputSchema.safeParse(parsed);
  if (!run.success) return [];

  const evidence: QualityEvidence[] = [];
  for (const result of run.data.results) {
    const criterionIds = input.criterionIdsByScenario[result.scenario];
    if (criterionIds === undefined || criterionIds.length === 0) continue;
    evidence.push(parseQualityInput(QualityEvidenceSchema, {
      id: randomUUID(),
      sourceArtifactId: input.sourceArtifactId,
      scope: input.scope,
      kind: "ACCEPTANCE",
      status: result.status,
      completedAt: input.completedAt,
      acceptanceTaskId: input.acceptanceTaskId,
      acceptanceTaskAttempt: input.acceptanceTaskAttempt,
      criterionIds: [...criterionIds],
    }));
  }
  return evidence;
}

/** Hash the exact captured file snapshot, including versions, without reading a filesystem. */
export function fingerprintProjectSnapshot(raw: unknown): string {
  const files = parseQualityInput(FilesSchema, raw);
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new QualityInputError();
  const canonical = files.map((file) => [file.path, file.version, file.content] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

# Quality and release assessment core

`@atoms/quality` is a deterministic, observe-only evaluator. It consumes supplied
evidence; it does not run checks, call models/providers, write source or database
records, register an agent, change run state, or authorize deployment.

## Inputs and decision

- `fingerprintProjectSnapshot(files)` hashes a captured set of actual
  `AgentProjectFile` paths, versions and contents. File order does not affect it.
- `createAcceptanceSnapshot({ scope, taskId, taskAttempt, output })` projects the
  existing Emma `userStories[].acceptanceCriteria` shape into `US-001:1`
  references. `taskAttempt` binds the snapshot to one specific attempt of that
  `AgentTask` row: the row is retried in place (same id, `attempt` incremented,
  `output` overwritten), so the same task id can carry different criteria text
  across attempts inside a single run attempt. Criterion ids are positional, not
  content-derived, so a superseded attempt's `US-001:1` and a later attempt's
  `US-001:1` can be textually different requirements sharing one id string.
- `evidenceFromValidationStep({ scope, commandId, step })` projects existing
  lint/typecheck/test/build command results without copying command text, stdout,
  stderr or errors. It never asserts acceptance coverage from a command exit code.
- `evaluateRelease({ scope, evaluatedAt, policy, acceptance, evidence })` returns
  `quality.assessment.v1`, `mode: OBSERVE_ONLY`, with `READY` or `BLOCKED`, check
  coverage, criterion references, and bounded diagnostic codes.

Scope includes workspace/project/run UUIDs, control version, attempt, and the
snapshot SHA-256. Each evidence record must match the assessment scope. Acceptance
evidence additionally names the exact Emma task, that task's attempt, and
criterion references; a mismatch on any of those is reported as
`ACCEPTANCE_TASK_MISMATCH` and blocks the assessment.

`STANDARD_RELEASE_POLICY` requires lint, typecheck, test, build, regression, E2E,
accessibility, performance, and security evidence. An explicit narrower policy
must still include all four baseline checks. The assessment records the policy;
READY means only that the supplied evidence satisfies that recorded policy.
Required missing evidence, any supplied non-passing evidence, duplicates, unknown
criteria, mismatched scope, future evidence, or evidence older than the policy
allows prevent READY. Malformed inputs throw `QualityInputError` with a fixed
message; they never produce an assessment. Evaluation time is caller-supplied.

## Trust and integration boundary

The caller must be a trusted evidence collector. Bind metadata when validation
runs against the captured files, and read immutable, authorized task/command
records. Do not stamp historical results with the latest project fingerprint or
accept model-written success claims as runner evidence. Consistent input fields
are not a cryptographic attestation of a real test execution.

This package can only check that the evidence it is *given* is internally
consistent (scope, task, attempt, and criterion references all line up, nothing
is missing, stale, from the future, duplicated, or non-passing). It has no way
to verify that a passed piece of evidence corresponds to a command that
genuinely ran, and no way to notice that a real failing result was withheld
while only fabricated or cherry-picked passing evidence was submitted for the
same check. Concretely:

- Evidence ids and `sourceArtifactId` values must come from the caller's own
  tamper-evident records (e.g. a `SandboxCommand` row id), never from model
  output, request bodies, or any input the run's own agents could influence.
  A caller that lets an untrusted party choose these values can satisfy every
  structural check here while attesting a test that never ran.
- The caller must submit *every* evidence record it produced for a given scope,
  not a filtered subset. Submitting only the passing runs of a flaky check and
  omitting the failing ones is invisible to `evaluateRelease`: nothing here
  can detect evidence that was never submitted in the first place.
- `taskAttempt` (above) stops a *stale* attempt of the same task from
  being accepted for a *later* attempt, but only if the caller correctly
  reads the task's current `attempt` value from its own store when building
  the acceptance snapshot. A caller that hardcodes or forgets to advance
  `taskAttempt` defeats this the same way stamping a historical result with
  today's project fingerprint would.
- A `PASSED` `QualityEvidence` record is a claim, not a receipt. This package
  deliberately never re-executes anything to check it (`evaluate.ts` reads no
  filesystem, network, or clock other than the caller-supplied `evaluatedAt`),
  so a compromised or buggy evidence collector remains a single point of
  failure the schema and evaluation logic here cannot see around. Treat the
  collector itself -- not this package -- as the security boundary for "did a
  test actually run."

The current worker executes the graph, then validation, then `completeRun` in
`apps/orchestrator-worker/src/processor.ts`. This package is not wired into that
sequence. Persistence, authorized API routes, SSE events, retries, human overrides,
and mandatory deployment gating need separate integration work. The current
schema uses `AgentName`, UUID IDs, and run status `COMPLETED`; it has no `AgentRole`
or project-wide revision integer. `qualityEvaluatorManifest` is capability
metadata, not a registered runtime `AgentManifest`.

Existing generic command reports do not contain per-criterion acceptance results
or evidence for every standard policy category. These gaps must remain BLOCKED
until a trusted producer supplies the missing evidence. No golden-prompt runtime
or staging success is claimed by the unit tests.

There is also no adapter here that builds `ACCEPTANCE`-kind `QualityEvidence`
(only `evidenceFromValidationStep` for the four baseline command checks exists).
A future integration needs its own trusted acceptance-test runner and adapter
that reads `AgentTask.attempt` at the moment it builds each acceptance snapshot
and evidence record, so `taskAttempt`/`acceptanceTaskAttempt` reflect the task's
real, current attempt rather than a value the integration layer has to remember
to thread through by hand.

## Development

```sh
pnpm install --frozen-lockfile
pnpm --filter @atoms/quality... build
pnpm --filter @atoms/quality test
pnpm --filter @atoms/quality... typecheck
pnpm verify
```

Only Zod is a runtime dependency. The agents and sandbox-provider workspace
dependencies are used by type-only compatibility tests. Full CI discovers the new
package through existing workspace/Turbo globs; no workflow change is needed.

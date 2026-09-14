# Quality and release assessment core

`@atoms/quality` is a deterministic, observe-only evaluator. It consumes supplied
evidence; it does not run checks, call models/providers, write source or database
records, register an agent, change run state, or authorize deployment.

## Inputs and decision

- `fingerprintProjectSnapshot(files)` hashes a captured set of actual
  `AgentProjectFile` paths, versions and contents. File order does not affect it.
- `createAcceptanceSnapshot({ scope, taskId, output })` projects the existing
  Emma `userStories[].acceptanceCriteria` shape into `US-001:1` references.
- `evidenceFromValidationStep({ scope, commandId, step })` projects existing
  lint/typecheck/test/build command results without copying command text, stdout,
  stderr or errors. It never asserts acceptance coverage from a command exit code.
- `evaluateRelease({ scope, evaluatedAt, policy, acceptance, evidence })` returns
  `quality.assessment.v1`, `mode: OBSERVE_ONLY`, with `READY` or `BLOCKED`, check
  coverage, criterion references, and bounded diagnostic codes.

Scope includes workspace/project/run UUIDs, control version, attempt, and the
snapshot SHA-256. Each evidence record must match the assessment scope. Acceptance
evidence additionally names the exact Emma task and criterion references.

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

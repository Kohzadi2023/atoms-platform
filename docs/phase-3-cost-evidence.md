# Phase 3 budget approval and actual cost evidence

Phase 3 now has two manual workflows. Neither workflow enables application run
execution or changes the private Preview Gateway. A cost finalization run does
not provision, migrate, delete, rebuild or rerun a provider resource.

## 1. Authorize and run the lifecycle

Use `Phase 3 staging evidence` on reviewed `main` with the existing three exact
confirmations, `run_live_provider=true`, the approved change ticket and region.
Set `approved_budget_cad` to the approved positive amount, at most `4`. There is
no actual-cost input on this workflow. Non-live migration/durability runs do not
need a provider budget.

The same scoped provider credentials, inventory controls, exact ownership
checks, approval-gated teardown and emergency cleanup remain required. A clean
lifecycle writes `phase3-provider-evidence-<attempt>` containing
`phase3-provider-evidence.json` with:

- version `phase3-provider-staging.v2`;
- the source repository, run ID, attempt and commit;
- the approved budget and `measuredVariableCostCadMicros: null`;
- all nine lifecycle gates passed and `variable_cost: PENDING`;
- result `AWAITING_COST` and no measurement provenance yet.

The final `Await cost finalization` step deliberately fails. This keeps the
provider exit unapproved until actual cost is known. All preceding lifecycle
jobs/steps must have succeeded, including the cleanup check. Do not use
GitHub's rerun button to resolve this expected failure: it can create another
billable resource in older workflows. The updated validator and runtime harness
both reject live execution when `GITHUB_RUN_ATTEMPT` is not `1`, so a rerun cannot
repeat provider provisioning. Record the cost with the second workflow instead.

## 2. Measure after cleanup

Retain a private cost record covering the exact source run and attempt. Include
the provider usage/billing observations, measurement time, CAD conversion basis
when needed, and the resulting actual incremental Supabase/E2B cost. Hash that
private record with SHA-256. Keep its contents and provider identifiers private;
only the digest goes into the public evidence.

The digest binds an operator attestation; it does not automatically verify a
provider invoice. If billing data is delayed, leave the result `AWAITING_COST`.
Never substitute an estimate, the approved budget, or a placeholder zero for
actual cost. Zero is valid only when the measured incremental charge is zero.

Budget validation is an authorization and evidence check, not a provider-side
spend limiter. Bound the run using the existing timeouts and approved provider
configuration; monitor resource cleanup. These checks cannot guarantee that a
provider will stop billing at the budget amount if cleanup fails.

## 3. Finalize the exact run without provider access

Use `Phase 3 final cost evidence` on reviewed `main`:

| Input | Value |
| --- | --- |
| `source_run_id` | The lifecycle run ID |
| `source_run_attempt` | Its exact attempt, which must still be the latest |
| `change_ticket` | The same ticket recorded in the lifecycle evidence |
| `measured_variable_cost_cad` | Actual measured CAD cost, up to six decimals |
| `measurement_source_sha256` | Lowercase SHA-256 digest of the retained private cost record |
| `cost_confirmation` | `I_ATTEST_ACTUAL_PHASE3_COST_AFTER_CLEANUP` |

The workflow uses only its GitHub token with Actions/contents read permissions.
It downloads the attempt-specific artifact as data, never executes its contents,
and verifies it against current GitHub source-run/job metadata. Forks, another
workflow, a different commit/attempt, incomplete cleanup, missing lifecycle
gates, stale rerun evidence or another failed source step are rejected.

`phase3-provider-final-evidence.json` retains the original lifecycle timestamps
and budget, adds the actual cost, recording actor/time and both source-record
and lifecycle-artifact SHA-256 fingerprints. The source artifact is unchanged.

Only an actual cost within both the approved budget and CAD 4 yields `PASSED`.
An over-budget measurement still writes a final `FAILED` artifact and fails
the finalizer job. Cleanup evidence is retained in either result. A failed
lifecycle or emergency-fallback cleanup can never be promoted to a pass.

Both source and final artifacts have 30-day retention. Reviewers must inspect
the final artifact and its source-run binding, not treat an old lifecycle
workflow or a version 1 record as current provider exit evidence. Archive the
redacted evidence and retain the private cost record according to the change
ticket's operational process before the artifacts expire.

GitHub's documented [cross-run artifact download](https://docs.github.com/en/actions/tutorials/store-and-share-data#downloading-artifacts-during-a-workflow-run)
and [workflow-run metadata](https://docs.github.com/en/rest/actions/workflow-runs)
support the source verification. No live provider execution was performed to
develop or test this workflow change.

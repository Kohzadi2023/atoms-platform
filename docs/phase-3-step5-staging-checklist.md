# Step 5 Staging Execution Checklist

Purpose: execute provider-backed live checks for Phase 3/4 safely, with explicit
approvals, bounded cost, and auditable evidence.

This checklist is the operator-facing companion to
`docs/phase-3-staging-runbook.md`.

## A. Preflight (required)

1. Confirm the environment-scoped GitHub boundary exists:
   - Name: `phase3-staging`
   - Required reviewers are optional for the approved solo-operator policy
   - Every live run still requires the exact solo-operator acknowledgement
2. Confirm required secrets/variables are configured in that environment:
   - `SUPABASE_ACCESS_TOKEN`
   - `SUPABASE_ORGANIZATION_SLUG`
   - `E2B_API_KEY` (optional `E2B_TEMPLATE`)
   - Optional override: `SUPABASE_MANAGEMENT_API_URL`
   - Optional override: `VAULT_NAMESPACE`
   - Optional overrides: `PHASE3_STAGING_MIN_OTHER_ORG_CONTROLS` and
     `PHASE3_STAGING_MIN_CUSTOMER_CONTROLS` (both default to `1`)
   - Do not configure `VAULT_ADDR`, `VAULT_TOKEN`, or `VAULT_KV_MOUNT` for this
     workflow. The environment-scoped job creates an isolated Vault dev server,
     generates and masks a per-job token, and removes the server after evidence
     capture.
3. Confirm control inventory exists before any live run:
   - At least one visible project in another organization
   - At least one customer-named project in the staging organization
4. Open/attach approved change ticket and budget note for billable/destructive
   operations.

Pass criteria:

- All preflight items are confirmed and documented in the change ticket.

## B. Non-live durability baseline (safe to run first)

Run from repository root:

```bash
pnpm staging:phase3:preflight
pnpm staging:phase3:durability
```

Optional machine-readable preflight output:

```bash
pnpm staging:phase3:preflight:json
```

Pass criteria:

- Command exits with code 0.
- Evidence artifact is generated and uploaded by the workflow/job.
- No secret values appear in logs or artifacts.

## C. Live provider-backed exit (environment-scoped staging only)

Trigger the manual staging workflow (`.github/workflows/phase3-staging.yml`) with:

- `run_live_provider=true`
- confirmation 1: `RUN_PHASE3_STAGING`
- confirmation 2: `PROVISION_MIGRATE_AND_DESTROY_SUPABASE_STAGING_DATABASE`
- confirmation 3: `I_ACCEPT_SOLO_PHASE3_PROVIDER_EXIT_WITHOUT_REVIEWER`

The solo-operator acknowledgement replaces a reviewer prompt; it does not
replace the separate change-ticket, cost, or destructive confirmations.

Before triggering the workflow, run local fail-fast checks:

```bash
pnpm staging:phase3:preflight:live
```

Optional machine-readable preflight output:

```bash
pnpm staging:phase3:preflight:live:json
```

Pass criteria:

- Workflow reaches completion after all explicit confirmation gates pass.
- Evidence includes provision -> health -> migrate/seed -> reconciliation path.
- Workflow uploads `phase3-preflight-evidence` (durability) and, when live is requested,
  `phase3-preflight-live-evidence` artifacts with preflight JSON.
- The ephemeral Vault container is reachable only on runner loopback and is
  removed by the final `always()` cleanup step.

## D. Post-run evidence validation

Validate evidence fields are complete and redacted:

1. Migration matrix results (upgrade path + empty install path)
2. Recovery/fencing outcomes
3. Orphan approval-gated lifecycle (`OPEN -> APPROVED -> CLEANING -> RESOLVED`)
4. Provider resources created/deleted exact counts
5. Measured variable cost (CAD)
6. Secret scan result

Pass criteria:

- Every mandatory runbook row has concrete values (not generic "pass").
- No provider IDs, access tokens, Vault values, or database URLs are leaked.

## E. Failure handling

If any gate fails:

1. Mark result as `FAILED` (never convert fallback cleanup into a pass).
2. Attach logs and evidence JSON to the change ticket.
3. Record the failed gate and next action in `docs/phase-4-verification.md`.
4. Keep normal orphan cleanup switch disabled outside protected test scope.

Pass criteria:

- Failure is actionable, auditable, and does not weaken safety controls.

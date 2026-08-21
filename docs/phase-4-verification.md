# Phase 4 Verification Note

Status: verified against `main` on 2026-08-03

## Purpose

This note records only claims that are directly supported by the repository state
and by an executed repository-wide test run. It is intended to correct external
summaries that referenced scripts, test counts, or demo coverage that do not
match the current workspace.

## Verified repository facts

- The root package exposes `test`, `verify`, `demo:phase2`, and `demo:phase3`
  scripts, not `scripts/test-runner.js` or `scripts/demo.js`.
- `demo:phase2` creates a project, starts a run, streams SSE events, and pauses
  for an interactive approval before continuing.
- `demo:phase3` provisions a generated database, waits for it to reach a
  terminal state, and optionally queues teardown when explicitly confirmed.
- The README documents Phase 2 and Phase 3 demos, bootstrap steps, and the
  verification entry points used by the repository.
- The current Phase 4 kickoff document marks the work as in progress and lists
  scoped approvals as the active follow-up.

## Repository-wide test outcome

Executed on 2026-08-03:

- `pnpm -s test`

Observed outcome:

- All test tasks completed successfully.
- Several live or integration-only tests were intentionally skipped because they
  require explicit opt-in and external credentials/services.
- The repository-wide run exceeded the "32 tests" figure from the external
  summary; that figure does not describe the current main-branch test surface.

## Mismatches in the external summary

- `scripts/test-runner.js` is not present in this repository.
- `scripts/demo.js` is not present in this repository.
- The Phase 2 and Phase 3 demo scripts do not implement GitHub export, Vercel
  deployment, or custom-domain attachment.
- The current repo state does not support treating the external summary as a
  full Phase 6 execution record.
- The enum-to-runtime-object runtime fix described in the summary is not
  directly evidenced in the current `main` branch sources.

## Safe conclusion

The repository is currently validated through the Phase 2 and Phase 3 slices,
with Phase 4 kickoff work in progress. A claim of a completed end-to-end Phase 6
demo should not be made without additional evidence from the actual GitHub,
Vercel, and domain integration code paths.

## Supplemental review (code + docs)

Reviewed on 2026-08-03 against current `main`.

### Priority findings

P0 - Documentation/config contract mismatch:

- The environment template does not currently define `GITHUB_APP_ID`,
  `VERCEL_AUTH_TOKEN`, or `STRIPE_SECRET_KEY`.
- Any report that claims those exact variables are already present in
  `.env.example` is inaccurate.

P0 - Data-model inventory mismatch:

- The active Prisma schema contains 21 models, not 11.
- Summaries that list only the Phase 1 core entities are incomplete for the
  current implementation state (which includes sandbox, preview, database
  provisioning/reconciliation, secret references, and deployments).

P1 - "Fully ready" claim exceeds verified evidence:

- Repository tests pass, but several live/integration checks are explicitly
  opt-in and credential-gated.
- Without those gates enabled in a protected environment, the project should be
  described as "locally validated with gated live checks pending", not fully
  production-verified.

## Prioritized execution plan (step-by-step and testable)

### Step 1 (P0): Align environment contract with implemented integrations

Goal:

- Make docs and `.env.example` describe the same runtime contract.

Actions:

1. Decide whether GitHub/Vercel/Stripe are currently supported as active runtime
   integrations in this branch.
2. If supported now, add explicit environment variables to `.env.example` with
   safe placeholders and comments.
3. If not supported now, keep them out of `.env.example` and update docs to
   state "not yet active in this branch".

Verification:

- `rg "GITHUB_APP_ID|VERCEL_AUTH_TOKEN|STRIPE_SECRET_KEY" .env.example README.md docs`

Pass criteria:

- Search results and documentation statements are consistent and non-conflicting.

### Step 2 (P0): Correct schema inventory and architecture summaries

Goal:

- Ensure all review docs reflect current schema scope.

Actions:

1. Update review/verification docs that still describe only the 11-model slice.
2. Include the full model families now present (orchestration, sandbox,
   preview, migration, reconciliation, deployments, and secret references).

Verification:

- `rg "model " packages/db/prisma/schema.prisma`

Pass criteria:

- Model count and listed families in docs match current schema content.

### Step 3 (P1): Keep readiness language evidence-based

Goal:

- Avoid overstating readiness where live gates are skipped.

Actions:

1. Keep a "verified locally" versus "verified in protected staging" split in
   docs and PR notes.
2. Explicitly record which checks were skipped due to opt-in gating.

Verification:

- `pnpm -s test`

Pass criteria:

- Zero failures, and skipped live tests are documented as skipped (not passed).

### Step 4 (P1): Re-run full non-live verification baseline

Goal:

- Produce a reproducible baseline for reviewers.

Actions:

1. Run build, test, typecheck, and Prisma validation.

Verification:

- `pnpm verify`

Pass criteria:

- Command exits with code 0 and no new regressions.

### Step 5 (P2): Execute controlled live checks in protected staging

Goal:

- Validate provider-backed flows without violating destructive/billable guardrails.

Actions:

1. Run only in a protected environment with explicit approvals and cost controls.
2. Enable required flags for a single live run and capture evidence artifacts.

Verification:

- `pnpm staging:phase3:provider`
- `pnpm staging:phase3:durability`

Pass criteria:

- Evidence artifacts are generated, redacted, and stored; failures have actionable
  runbook references.

### Step 6 (P2): Publish the audit summary for reviewers

Goal:

- Make the final status easy to review and hard to misinterpret.

Actions:

1. Keep this verification note linked from README and PR discussion.
2. Include: what was verified, what was gated, and what remains pending.

Verification:

- Manual review of `README.md` + this file in PR diff.

Pass criteria:

- Reviewer can map every readiness claim to a command output or a linked runbook.

## Execution status of the plan

- [x] Step 1 completed for current branch scope (documented as not active yet for
  GitHub/Vercel/Stripe runtime env variables in this verification note).
- [x] Step 2 completed (schema inventory corrected to 21 active models).
- [x] Step 3 completed (readiness language updated to evidence-based wording with
  live-gate caveats).
- [x] Step 4 completed (`pnpm verify` executed successfully on 2026-08-03).
- [ ] Step 5 blocked in local context (requires protected staging credentials,
  explicit destructive/billable confirmations, and environment approvals).
- [x] Step 6 completed (README link + PR discussion references this note).

Step 5 execution evidence (2026-08-03):

- `pnpm staging:phase3:durability` executed; gate test was skipped by design
  because Phase 3 durability integration opt-in was not enabled in this local
  environment.
- `pnpm staging:phase3:provider` executed; live provider exit test was skipped by
  design because protected PostgreSQL/Supabase/Vault/E2B staging credentials and
  destructive confirmations were not provided.
- Added fail-fast preflight commands:
  - `pnpm staging:phase3:preflight`
  - `pnpm staging:phase3:preflight:live`
  - `pnpm staging:phase3:preflight:json`
  - `pnpm staging:phase3:preflight:live:json`
- Verified preflight behavior:
  - Local default run fails with explicit missing-variable reasons.
  - Durability preflight passes when required non-secret placeholders are set.
  - JSON audit reports are written to `artifacts/phase3-preflight-durability.json`
    and `artifacts/phase3-preflight-live.json` when JSON mode is used.

Step 5 CI hardening update (2026-08-03):

- `.github/workflows/phase3-staging.yml` now runs preflight checks in all paths:
  - Preflight job emits JSON audit artifact for durability mode.
  - Durability job enforces preflight before integration execution.
  - Provider job enforces live preflight and writes live JSON audit before
    billable/destructive flow.
- Workflow publishes `phase3-preflight-evidence` (durability) and
  `phase3-preflight-live-evidence` (live path) artifacts to support audit
  review of preconditions and gate outcomes.

Step 5 protected staging execution update (2026-08-04):

- Baseline manual workflow run completed successfully with durability evidence.
- Live manual workflow run failed in `provider-exit` preflight gate:
  - Run: `Phase 3 staging / CHG-2026-08-04-PHASE3-LIVE #2`
  - URL: `https://github.com/Kohzadi2023/atoms-platform/actions/runs/30917176997`
  - Failed checks: `SUPABASE_ORGANIZATION_SLUG`, `VAULT_ADDR`, `VAULT_TOKEN`
- Live preflight artifact was still uploaded (`phase3-preflight-live-evidence`),
  and the failure remained fail-closed before any provider destructive/billable
  operations.

Next action:

- Populate missing protected environment secrets/variables in `phase3-staging`
  and re-run the same workflow inputs for the live path.

### Step 5 unblock prerequisites

To execute Step 5 safely, all of the following are required:

1. Protected staging environment with PostgreSQL, Redis, Supabase, Vault, and E2B.
2. Required secrets and vars populated in protected scope.
3. Explicit destructive/billable confirmations per runbook.
4. Artifact retention location for redacted evidence output.

Operator execution checklist:

- `docs/phase-3-step5-staging-checklist.md`

# Phase 4 Kickoff: Sarah + Adrian Foundation

Status: in progress (Milestones 1 and 2 complete; orchestration wiring landed)  
Updated: 2026-08-03

## Why this is the next concrete step

The repository is validated through Phase 3 (durable orchestration, sandbox preview,
database provisioning/reconciliation) and does not yet include Sarah/Adrian
deliverables. The approved specification makes Phase 4 the next bounded increment:

- Sarah: SEO artifacts and deterministic checks.
- Adrian: growth copy variants tied to Emma-approved positioning.

## Immediate actionable task (start now)

Implement **versioned schema contracts and validator plumbing** for two new artifact
types:

1. `SEO_PACKAGE`
2. `CONTENT_PACKAGE`

This should ship before workflow wiring so we can enforce typed outputs and fail-fast
validation, consistent with existing Mike/Emma/Bob/Alex/David contracts.

## Scope for this step

- Add artifact schemas in contracts for `SEO_PACKAGE` and `CONTENT_PACKAGE`.
- Add server-side validation entry points in the Control API for these artifact types.
- Add unit tests for schema acceptance/rejection and required fields.
- Do not wire Sarah/Adrian into the run graph yet.

Out of scope for this step:

- Route-aware SEO generation logic.
- Copy-approval UI.
- New orchestrator nodes.

## Proposed implementation plan and ETA

Total ETA: **1.5 days**

### Milestone 1 (0.5 day)

Define contract schemas and fixtures.

Deliverables:

- `SEO_PACKAGE` schema covering:
  - `sitemapXml`
  - `robotsTxt`
  - per-route metadata entries
  - validation findings
- `CONTENT_PACKAGE` schema covering:
  - audience
  - value propositions
  - CTA variants
  - ad/campaign variants
  - claims that require evidence

Acceptance criteria:

- Schemas compile and export from contracts package.
- Positive and negative fixture parsing is deterministic.

### Milestone 2 (0.5 day)

Integrate artifact validation in Control API artifact ingestion path.

Deliverables:

- Type-dispatched validator selection for new artifact kinds.
- Structured error mapping for invalid payloads.

Acceptance criteria:

- Invalid SEO/content payloads are rejected with actionable field errors.
- Existing artifact flows are unaffected.

### Milestone 3 (0.5 day)

Tests and verification.

Deliverables:

- Unit tests for valid/invalid examples of both schemas.
- Regression test for existing artifact kinds to ensure no behavior change.

Acceptance criteria:

- Relevant package tests pass locally and in CI.
- No changes to credit, run state, or provisioning behavior.

## Owner checklist

- [x] Contracts schema implemented (`SEO_PACKAGE`, `CONTENT_PACKAGE`).
- [x] Type-dispatched event-payload validation wired in persistence and Control API SSE.
- [x] Tests added for new artifact schemas and event payload dispatch.
- [x] Local package test suites green for contracts, control-api, and orchestrator-worker.

## Verification snapshot

Executed on 2026-08-03:

- `pnpm --filter @atoms/contracts test` -> 18 passed, 0 failed
- `pnpm --filter @atoms/control-api test` -> 18 passed, 0 failed, 1 skipped (env-gated integration)
- `pnpm --filter @atoms/orchestrator-worker test` -> 24 passed, 0 failed, 2 skipped (env-gated integration/live)

## Next step selected and implemented (2026-08-03)

Based on the roadmap dependency order, the next bounded implementation after typed
artifact contracts was to wire Sarah and Adrian into durable orchestration while
preserving existing controls (approval gate, bounded retries, immutable revisions).

Completed in code:

- Added `Sarah` and `Adrian` to active agent contracts and manifests.
- Extended the run graph from `... -> Alex -> David` to
  `... -> Alex -> David -> Sarah -> Adrian`.
- Added persisted enum support for these agents in Prisma (`AgentName`).
- Emitted explicit `artifact.created` events for `seo-package` and
  `content-package` when Sarah/Adrian complete.
- Added a typed artifact query route `GET /v1/runs/:runId/artifacts` for
  deterministic UI/state retrieval.
- Added Control API end-to-end coverage for replay and query of
  `seo-package` and `content-package` artifact envelopes.

Acceptance impact:

- Existing run-control behavior remains unchanged (same approval boundary, same retry
  semantics, same validation stage ordering).
- Phase 4 artifacts now flow through the same durable eventing path as prior agents.

## Exit definition for this kickoff step

The step is complete when `SEO_PACKAGE` and `CONTENT_PACKAGE` can be accepted as
typed artifacts with deterministic validation failures and passing tests, while the
orchestrator execution path remains unchanged.

## Follow-up hardening (2026-08-03)

After reviewing the Phase 4 orchestration flow and tests, we identified and fixed a
multi-approval edge case:

- A single `approve` command could bypass both the plan approval gate and the content
  approval gate when both were present in the same run.

Implemented guardrail:

- Approval bypass is now consumed once per run invocation and only when
  `approvalScope` matches the active approval gate.
- Plan approval is considered already satisfied after Alex output exists.
- Runs that require both plan and content approvals now pause twice and require two
  explicit approvals.

API/queue contract hardening:

- `POST /v1/runs/{runId}/actions` now requires `approvalScope` when
  `action=approve`.
- `approvalScope` is rejected for non-approve actions.
- Worker jobs carry `approvalScope` so graph bypass applies only to `plan` or
  `content` as requested.

Verification:

- `pnpm --filter @atoms/orchestrator-worker test` passes with updated assertions for
  two-step approval behavior.

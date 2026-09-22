# Decision Record DR-001: activating live provider credentials (issue #14)

```yaml
id: DR-001
title: Activate real OpenAI/E2B credentials for live execution (issue #14)
status: PROPOSED   # not APPROVED. See "Status" below.
owner: null        # unassigned -- see "Not settled"
decisionQuestion: >
  Is it authorized to enable real OpenAI/E2B provider credentials on the
  orchestrator-worker (issue #14), and if not now, what closes first?
supersedes: null
relatedTo:
  - docs/adr/production-execution-gate.md
  - docs/azure-container-apps-preview-staging.md
input: operations-review-panel, round 4, 2026-09-22
threshold:
  costCeiling: null       # panel proposed "$5/hour" for a live window; not owner-approved
  windowDuration: null    # panel proposed "2 hours"; not owner-approved
acceptanceCriteria: []    # none ratified; see "Proposed P0 prerequisites"
```

## Status

**PROPOSED, not decided.** This file exists to close a specific gap: an
operations review (round 4, summarized 2026-09-22) reached a set of
recommendations about issue #14, and its own summary noted a live
contradiction -- one participant treated the recommendation as already
"registered and locked," while the record of this workspace (this repository,
its issues, its PRs) had no Decision Record of any kind. Checked directly
against the repository and GitHub issues on 2026-09-22: no prior decision
record existed anywhere. That absence is now closed by this file, which
records the panel's recommendation as a **proposal awaiting an owner**, not a
ratified decision. Nothing in this file authorizes enabling issue #14.

## Decision question

Same three-part question the panel worked from:

1. Is enabling real provider credentials (issue #14) authorized right now?
2. If not, which prerequisites close first, and in what order?
3. Queue architecture: containerized Redis (validation-only) vs. migrating
   the queue to PostgreSQL -- neither is adopted; both remain open.

## What is already true, independent of this proposal

Verified against the repository and Azure on 2026-09-22, not sourced from the
panel:

- `RUN_EXECUTION_ENABLED` defaults `false`; issue #14's provider credentials
  are not configured on the worker. Live execution is already off.
- This is not a new decision to keep it off: it is the standing rule the
  project owner gave directly (2026-09-21): keep Azure/provider spend at
  minimum until the project is finished, and make sure it cannot increase.
  The panel's "No-Go for #14, for now" conclusion is consistent with that
  standing rule, not an alternative to it.
- Managed Redis for staging was deleted 2026-09-21 (see
  `docs/azure-container-apps-preview-staging.md`); no queue currently runs in
  any environment. The panel's "containerized Redis, validation-only" vs.
  "migrate to Postgres" question is about a future rebuild, not a live
  system today.

## Proposed P0 prerequisites (panel's recommendation, unratified)

Each row is the panel's proposed item, carried here verbatim in substance so
it is not lost, explicitly **not** owned or approved:

| # | Item | Proposed owner | Proposed acceptance | Status |
|---|---|---|---|---|
| 1 | This Decision Record itself | Product | Contradiction resolved, owner and threshold recorded | Done by this file's existence; threshold still unset |
| 2 | Validation-only containerized Redis, hardened | SRE + Backend | 1,000-job PoC; restart loses no job | Not started |
| 3 | Transactional Outbox + idempotency | Backend | Zero orphaned jobs across a DB/Redis crash | Not started |
| 4 | Circuit breaker + DLQ (Postgres) + app-level log dedup | Backend + QA | No infinite retry | Partially present: `throttled-log.ts` (#122) deduplicates repeated error logs; no circuit breaker or DLQ exists |
| 5 | Readiness + Authorization API (two-part contract) | Backend + Frontend | `423` with a `reasonCode`; zero provider calls while blocked | Readiness half exists (G7, `evaluateExecutionReadiness`); no separate Authorization concept exists |
| 6 | Kill switch enforced at queue claim and `POST /start` | Backend + SRE | Claim stops in <5s; $5/hour threshold | `RUN_EXECUTION_ENABLED` is already a kill switch at the Control API; not enforced separately at queue-claim time |
| 7 | Token bucket / rate limiter (app layer) | Backend + SRE | n/a | Not present. Existing budget control (G1, #103) is a spend ceiling, not a rate limiter |
| 8 | Security log separated from operational log; unbounded audit trail | Security + Backend | Survives log-flooding | Not present. Directly relevant: this is what the 2026-09-20 incident's log flood would have obscured if security-relevant events shared the same capped stream |
| 9 | Secrets only from Key Vault + IaC, machine-revocable | Security + SRE | n/a | Partially present: `VaultSecretStore` exists for database-provider secrets; not audited for this scope |
| 10 | G3 (acceptance manifest + Playwright runner) | Frontend + UX | Four journeys, no live credentials needed | **In progress** -- see the G3 PR opened alongside this record |
| 11 | Chaos test on a mock, then a real 2-hour window | QA | Veto until passed | Not started |

Rows 4, 5, 6, 9 already have partial platform support; the table says so
rather than treating the panel's item as either fully open or fully closed.
No row here is authorized work -- it becomes actionable only when someone
takes ownership of it and the owner sets its acceptance threshold.

## Consensus this record does confirm as already true

- Issue #14 is not enabled today, for reasons independent of this panel
  (the owner's standing cost rule).
- G3 (evidence-based acceptance) does not need issue #14 or a queue and can
  proceed in parallel. It is not blocked by anything in this record.

## Not settled by this record

- An owner for this record itself, or for any prerequisite row above.
- The cost ceiling and window duration for a future live-credential window
  (panel proposed $5/hour and 2 hours; neither is approved).
- Queue architecture: containerized Redis (validation-only) vs. a PostgreSQL
  queue. Both remain candidate designs; recreating Redis "with the same
  settings" (the prior operational note in
  `docs/azure-container-apps-preview-staging.md`) is the fallback if staging
  needs to come back before this question is resolved, not an endorsement of
  either option over the other.
- Scope of the Atoms -> Genesisco rename beyond the display layer.

## What changes because this record exists

Nothing operational. `RUN_EXECUTION_ENABLED` and issue #14 stay exactly as
they were before this file was written. What changes is that "is there a
recorded decision" now has one honest, checkable answer: no -- this is a
proposal, and its `status` field says so in a place both a person and a
script can read.

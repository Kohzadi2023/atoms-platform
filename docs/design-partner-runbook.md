# Design partner runbook: limited live execution

Status: draft, written 2026-09-19 from the team review and the state of the code. Live execution is **off**. Nothing here has been run against a live provider. Numbers marked **proposal** are not decisions; the people who own the risk have to accept or change them.

Source of truth for the gates is `docs/adr/production-execution-gate.md`. This runbook is the operating procedure once those gates pass.

## Scope

- Up to 10 design partners, one at a time to start.
- One template: the agency client portal. The vendor tracker and ticketing templates are paused through Q1.
- Guided pilot: someone from the team is present for the first runs of each partner. The partner receives a workspace, not a static application.
- The only permitted description of any output is **"Validated Preview"**. Do not say "Release Ready", "Production Ready" or "Verified Application" until acceptance evidence (G3) exists.

## Before the first partner

All of these must be true. Do not enable the flag if any is not.

1. The P0 table in the ADR has no `Partial` row. Today it does: the live egress probe and the real-Chromium check have not run.
2. The sandbox template (`E2B_TEMPLATE`) carries Playwright and Chromium (see the staging runbook, "Before enabling live execution").
3. The worker has these settings, all set deliberately, and `E2B_ALLOWED_HOSTS` is still the two package registries:
   - `RUN_PROVIDER_BUDGET_USD_MICROS` (per-run ceiling)
   - `WORKSPACE_PROVIDER_BUDGET_USD_MICROS_PER_DAY` (required whenever the per-run budget is set)
   - `PREVIEW_BROWSER_VIABILITY=required`
   - `SANDBOX_EGRESS_VERIFIED_AT`, set only after the live egress probe passed
   - real `OPENAI_API_KEY` and `E2B_API_KEY`
4. The partner's workspace exists and its plan is set. Sophia, Sarah and Adrian run only on `PRO` or `MAX`; on `FREE` they are skipped. A workspace OWNER or ADMIN changes it with `PATCH /v1/workspaces/:workspaceId/plan`; there is no screen for it. Create the partner's project as a client portal with `POST /v1/projects` and `"projectType": "CLIENT_PORTAL"` (there is no screen for it yet). That type does not run Sophia, Sarah or Adrian at all, so the plan does not matter for them; a project created without a type is `GENERAL` and behaves as before.
5. The partner has accepted terms that state how long the data of paused runs is kept (see "Terms").
6. Someone is named as the person who can stop the program (see "Stopping").

## Enabling

1. Run the pre-flight. It only reads `/readyz`:

   ```bash
   pnpm readiness:check --origin https://api.genesisco.io --for-enable
   ```

   It must exit `0`. Exit `1` lists the failing gates by ID; exit `2` means the check could not run.
2. Flip `RUN_EXECUTION_ENABLED=true` with a change-ticketed `az containerapp update` on the Control API, so the Azure Activity Log entry is the audit trail.
3. Run the check again without `--for-enable`. It must exit `0` and must not report `INCONSISTENT`.
4. Start the first partner run yourself, with the partner watching.

## What a run looks like

1. The partner submits a prompt and optional plain-text attachments.
2. The run stops at **plan approval** whenever attachments are present, even if the model judged none necessary. The planning agents have already run by then, but no code has been generated.
3. The partner reads the requirements list the agents derived, ticks the confirmation, and approves the plan; later the content variants (if Adrian ran). The confirmation is enforced by the web app, not by the API, so a partner using the API directly is not asked.
4. The sandbox is created only after all agents finish; it validates (install, lint, typecheck, test, build), starts the preview and loads it in a real browser.
5. A run that ends `FAILED` carries a reason in its error payload: `FAILED_BUDGET_EXHAUSTED`, `FAILED_PROVIDER`, `FAILED_VALIDATION` or `FAILED_INTERNAL`.

A paused run holds no job, sandbox or compute, but it does hold data. With `PAUSED_RUN_TTL_HOURS` set on the worker, a run paused longer than that many hours is cancelled (`error.code = APPROVAL_EXPIRED`); the data stays. With it unset (the default) nothing expires (issue #100).

## Daily monitoring

Run these against the production database, read-only. Amounts are micro-USD in the tables; the queries divide by one million.

Spend per workspace and day, from the actual-cost record. `actual_usd_micros` is telemetry taken from the provider's reported usage, so a call without a cost estimate adds nothing and this figure can undercount. The reserved figure is the enforced upper bound.

```sql
SELECT r.workspace_id,
       r.created_at::date                    AS day,
       count(*)                              AS runs,
       sum(b.actual_usd_micros) / 1e6        AS actual_usd,
       sum(b.reserved_usd_micros) / 1e6      AS reserved_usd
FROM atoms_runtime.run_provider_budgets b
JOIN public.agent_runs r ON r.id = b.run_id
WHERE r.created_at >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 2 DESC, 4 DESC;
```

How close each workspace is to its daily ceiling today:

```sql
SELECT workspace_id, window_date, reserved_usd_micros / 1e6 AS reserved_usd
FROM atoms_runtime.workspace_provider_budget_windows
WHERE window_date = (now() AT TIME ZONE 'UTC')::date
ORDER BY reserved_usd_micros DESC;
```

Outcomes and failure reasons over the last week:

```sql
SELECT status, error ->> 'reason' AS reason, count(*)
FROM public.agent_runs
WHERE created_at >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

Runs waiting on a person, oldest first (read this list every day even with expiry on; it cancels, it does not tell anyone):

```sql
SELECT id, workspace_id, paused_at
FROM public.agent_runs
WHERE status = 'PAUSED'
ORDER BY paused_at;
```

Also look at, by hand for now: how many runs a human had to help with, how long approvals waited, and the support load per partner. None of these is instrumented yet, and cost per accepted outcome cannot be computed until G3 defines "accepted". Until then track cost per completed run and say so.

## Stopping

Any one of these pauses the program until the owner decides otherwise. The first is the only number the team review stated; the rest are **proposals**.

- Cost per accepted outcome above 20% of that account's revenue. (Stated in the review. Not measurable until G3.)
- **Proposal:** a workspace hits its daily ceiling on two consecutive days.
- **Proposal:** more than a quarter of a partner's runs end `FAILED_VALIDATION` or `FAILED_INTERNAL` over a week.
- **Proposal:** any confirmed case of a generated application containing something the partner did not request that came from an attachment.
- Any security incident.

To stop: set `RUN_EXECUTION_ENABLED=false` on the Control API. New runs are refused, and so is any action that would enqueue work (approve, resume, retry); cancel and pause still work, so cancel in-flight runs from the run controls. Record why. The worker keeps its own budget lock, so setting `RUN_PROVIDER_BUDGET_USD_MICROS=0` on the worker also stops every model call (`PROVIDER_BUDGET_DISABLED`) if the flag cannot be reached.

## Terms

Partner terms need a clause on retention of paused-run data. Draft wording, **not legal advice and not reviewed by counsel**:

> If a run is paused awaiting your approval, we retain the run's prompt, attachments and generated outputs until you approve, cancel, or ask us to delete them, and in any case no longer than [N] days after the run was paused, after which we may delete them.

The number of days is a decision for the owner. The platform can cancel a run after that time (`PAUSED_RUN_TTL_HOURS`), but cancelling does not delete anything: the prompt, attachments, outputs and checkpoint stay. Deletion is not built, so a promise of deletion within N days can only be kept by hand today (issue #100).

## Open decisions

- Who owns each P0 gate and the stop decision.
- The proposal thresholds above.
- The retention period, the value of `PAUSED_RUN_TTL_HOURS` (it is off until set), and whether to build the data purge and the reminder (#100) before the first partner.
- Confirm the client portal's agent set (Emma, Mike, Bob, Alex, David) in `docs/client-portal-reference-architecture.md`. It is implemented as proposed (`PROJECT_TYPE_AGENTS`); changing it is a one-line edit.
- The order in which design partners become paying customers.

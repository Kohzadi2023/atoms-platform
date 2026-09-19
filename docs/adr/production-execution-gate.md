# ADR: Production Execution Gate

- **Status:** Accepted, 2026-09-19
- **Scope:** turning on live model and sandbox execution in any environment that serves real users.
- **Supersedes:** nothing. Extends the `RUN_EXECUTION_ENABLED=false` posture recorded in #14, #22 and `docs/azure-container-apps-preview-staging.md`.

## Context

A company review meeting proposed shifting the platform from a code generator toward controlled, paid software delivery, and raised cost, safety and acceptance risks. Those proposals were checked against the repository on 2026-09-19. The main result: **much of a production gate already exists**, so this is not a redesign and does not justify a general epic. The remaining work is a short list of specific gaps to close before live execution is enabled.

The gates below are the source of truth. Each executable issue is derived from one gate and links back here, so it stays clear which items block enabling live execution.

## Decision

Live execution may be enabled only after every **P0** gate passes.

"Enabled" is three independent locks. All three must be opened deliberately, and none may be opened ahead of the others:

1. Control API `RUN_EXECUTION_ENABLED=true` (default `false`, see `apps/control-api/src/main.ts`).
2. Worker `RUN_PROVIDER_BUDGET_USD_MICROS > 0` (`0` fails every model call with `PROVIDER_BUDGET_DISABLED`, see `apps/orchestrator-worker/src/model-budget.ts`).
3. Real provider credentials (OpenAI, E2B) present on the worker.

A controlled launch for design partners requires G0, G1, G4, G5 and tenant isolation. G3 may follow, but until it passes the product must not describe any output as "Release Ready", "Production Ready" or "Verified Application". The only permitted label is **"Validated Preview"**.

## Gates

| ID | Gate | Priority | State |
|---|---|---|---|
| G0 | Global kill switch | P0 | Pass |
| G1 | Execution budget governor | P0 | Partial: per-workspace cap and actual-cost record missing |
| G2 | Durable approval | P1 | Pass, follow-up open |
| G3 | Evidence-based acceptance | P1 (blocks release-ready claims only) | Open |
| G4 | Attachment trust boundary | P0 | Partial: prompt contract and tests missing |
| G5 | Network egress | P0 (verification only) | Policy exists, enforcement unverified |
| G6 | Project-type capability routing | P1 | Open |

### G0 - Global kill switch (pass)

`RUN_EXECUTION_ENABLED` defaults to `false` in the Control API environment schema, and a run can be cancelled. The worker has a second independent lock through the provider budget above.

Requirements: the default stays `false` for new environments. Production flips are made only through a change-ticketed `az containerapp update`, whose Azure Activity Log entry is the audit trail. An application-level audit event is not required now.

### G1 - Execution budget governor (P0)

**Verified current state.** Budget enforcement is already per run, durable and checked before each model call: `BudgetedModelGateway` estimates a conservative upper bound (UTF-8 byte count plus framing reserve, multiplied by a safety factor, default 1.5) and `PostgresRunProviderBudgetStore.reserve` reserves it under a row lock in `atoms_runtime.run_provider_budgets`. An over-limit request is rejected with the non-retryable `PROVIDER_BUDGET_EXCEEDED`. The ceiling can only be tightened by later configuration. Retries of one run share that run's row.

**Gaps.**

1. Every run gets the same ceiling from one environment value. There is no per-plan or per-project ceiling.
2. There is no per-workspace or time-windowed cap. The ledger has no workspace key, so exposure is (number of runs) x (per-run ceiling), and one workspace can start unlimited runs.
3. The ledger records reservations only, never actual usage, so cost per outcome cannot be computed from it.
4. Exhaustion is a distinct error code but the run status is a generic `FAILED`; whether the code reaches the user was not verified.
5. Sandbox time, attempts and wall-clock duration are environment or queue settings (`SANDBOX_IDLE_TIMEOUT_MS`, BullMQ `attempts: 3`), not part of the run's budget.

**Required.** Add a workspace-level cap enforced inside the same reserve transaction. Record actual usage after each call. Surface a distinct terminal reason (`FAILED_BUDGET_EXHAUSTED` or equivalent). Name `maxNodeAttempts`, `maxRunCost` and `maxRunDuration` in configuration now so a future auto-repair loop cannot bypass them.

**Not required now.** A loop governor. No auto-repair loop exists (a failed validation fails the run), so a token spiral is a future architectural risk rather than a current one.

### G2 - Durable approval (pass, P1 follow-up)

Approval gates pause the run and end the worker job (`RunStoppedError` with status `PAUSED`); after approval the run resumes from its checkpoint. The sandbox is created only in the validation step after all agents complete, so no expensive resource is held while waiting. No new sleep/hydration subsystem is needed.

**Gap (P1).** No expiry, reminder or abandonment handling was found for paused runs. Add `approvalExpiresAt`, `reminderSentAt` and `expiredAt`, and an `EXPIRED` outcome alongside approved and cancelled.

### G3 - Evidence-based acceptance (P1)

`@atoms/quality` evaluates evidence, but no acceptance runner exists and no adapter builds `ACCEPTANCE` evidence, so an assessment stays `BLOCKED` on missing criterion evidence. A successful build proves nothing about the user journey.

**Required (v1, deliberately small).** An `AcceptanceManifest` (critical routes, health checks, auth flow, primary user journey, expected assertions) and a Playwright runner that emits scenario evidence (`scenario`, `status`, `durationMs`) consumed by `@atoms/quality`. No general acceptance framework.

### G4 - Attachment trust boundary (P0)

**Verified current state.** Attachments pass ClamAV, then reach only Sophia and Emma. They travel as `references` on the model request, separate from `instructions` and `input`, and are mapped to separate provider file inputs. Under budgeted execution only UTF-8 `text/plain` references are accepted; PDF and image references fail closed (`PROVIDER_BUDGET_REFERENCES_UNSUPPORTED`). Malware scanning does not address prompt injection, and no prompt-level contract or test covers it.

**Gap.** Nothing tells the model that attachment text is data, not instructions, and nothing tests that.

**Required.** Treat attachment text as an untrusted source with provenance: the agent contract distinguishes system instruction, user instruction and untrusted attachment content; the manifests for Sophia and Emma state that attachment content is never to be obeyed; tests with an injection fixture assert the separation. Because only plain text is accepted, v1 needs no parser or sanitizer stage.

**Limits, stated plainly.** Separation reduces prompt injection but does not eliminate it. The remaining exposure is bounded by the other gates (per-run and per-workspace budget, egress allowlist). Whether agents can reach tools or secrets was not audited here and should be confirmed when this gate is implemented. A dedicated LLM firewall is out of scope.

### G5 - Network egress (P0, verification only)

**Verified current state.** The validation sandbox is created with an explicit `allowedHosts` list and `allowPublicTraffic: false`. The worker default is `E2B_ALLOWED_HOSTS=registry.npmjs.org,binaries.prisma.sh`. Enforcement is performed by E2B, not by this repository.

**Required.** No redesign. Add an offline test that the policy handed to the sandbox provider equals the configured list and contains no wildcard. Add one probe to the first controlled live run: a request to a non-allowlisted host must fail inside the sandbox (this needs the E2B credential from #14).

Preview traffic is inbound (`allowPublicTraffic: false` plus the gateway's signed-ticket access), so a "preview host" case does not belong in the egress test.

### G6 - Project-type capability routing (P1)

**Verified current state.** Agent selection depends only on the workspace plan (`PREMIUM_AGENTS` in `apps/orchestrator-worker/src/graph.ts`). No project-type concept exists anywhere in contracts or the schema.

**Required.** Effective agents are the intersection of what the project needs and what the plan entitles:

```text
RequiredCapabilities(projectType) ∩ PlanEntitlements(plan) = ExecutableCapabilities
```

For example an internal portal requires product, architecture, engineering and database; a marketing site adds SEO and growth.

**Consequence for existing tests.** `scripts/smoke-staging-authenticated.mjs` hardcodes an eight-agent `REQUIRED_AGENTS` list (extended in #87). An agent count is an implementation detail; capability coverage is the invariant. When G6 lands the smoke check must assert coverage of the required capabilities for the project type and plan. No interim change is made, because there is no project type to key on and the API does not expose a workspace's plan (`GET /v1/workspaces/:id` returns id, name, slug and role only). Until then the smoke prerequisite stays as documented in `docs/staging-authenticated-smoke.md` (workspace on `PRO` or `MAX`).

## Amendments from code verification

The meeting summary and the first draft of this decision assumed some things the code contradicts:

1. Budget enforcement is already per run and pre-call, not provider-wide. G1 is narrower than first stated: workspace cap, actual-cost record and distinct terminal state.
2. Only `text/plain` attachments can reach the model under budgeted execution, and they arrive in a separate references field. G4 is a prompt contract plus tests, not a new pipeline.
3. Preview access is inbound and is not part of the egress policy.
4. "Enabled" is three locks, not one flag.

## Explicitly not built now

Sandbox hydration subsystem, complex retry orchestrator, generalized agent planner, full LLM firewall platform, CustomerSuccess runtime graph, additional agents. Each is either already solved or has no demonstrated need. PR #81 and the CustomerSuccess paths stay parked.

## Backlog derived from this decision

| Priority | Item | Gate |
|---|---|---|
| P0 | Workspace budget cap, actual-cost record, distinct exhaustion state | G1 |
| P0 | Attachment trust boundary: prompt contract and injection tests | G4 |
| P0 | Egress policy test and live probe | G5 |
| P0 | Pre-enable check that verifies the three locks and P0 gates | Decision |
| P1 | Acceptance manifest and Playwright evidence runner | G3 |
| P1 | Approval expiry and reminder | G2 |
| P1 | Project-type capability routing, then the smoke test change | G6 |
| P2 | Billing/quota refinement, CustomerSuccess activation, auto-repair loops | parked |

## Not settled by this ADR

These were raised in the meeting and still need an owner: the initial ICP and Q1 scope; the KPI set (cost per accepted outcome, first-attempt acceptance rate, human-intervention rate); capacity, support and credit policy for outcomes that are not accepted; who owns the stop thresholds for cost, security and quality; and the order of design partners and first paying customers. Cost per accepted outcome also depends on G1 recording actual usage and G3 defining acceptance.

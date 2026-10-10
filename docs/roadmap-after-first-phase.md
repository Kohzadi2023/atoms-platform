# Roadmap after the first phase

Written 2026-10-10. This is a working list, reconstructed from conversations and
code reading, not an approved plan. Nothing here is scheduled.

## What "the first phase" means

The first phase is **complete, repeatable runs on Azure staging with Gemini**:
create project, approve the plan, Alex and David generate, the sandbox validates,
and Preview opens, with no manual Retry. Everything below waits until that is
reliable. Items marked *founder decision* are not engineering calls.

Still inside the first phase (not in this list): more clean consecutive runs,
live verification of the local-database preview template (`DB_START`,
`DB_MIGRATE`, `DB_SEED` exit codes of run `307ea91d`), and the Preview-expired
UI state (PR #155).

## Items

### 1. Core GA checklist
Remaining Core GA items. *Founder decision* on scope and date. The checklist
itself lives outside this file; copy it here when work starts.

### 2. Pricing and billing
Workspace plan management, checkout, and Phase 6 Billing. Today `Workspace.plan`
exists with `FREE` as the default and no route or UI changes it. Depends on
item 3 (what each plan unlocks).

### 3. Marketing and sales for the apps Genesisco builds
Genesisco builds applications; the apps it builds should come with a
marketing and sales surface. What the code does today:

- Sophia (market, ICP, competitors), Sarah (SEO package) and Adrian (CTA and ad
  copy) exist, but run in this order:
  `Sophia, Mike, Emma, Bob, approval, Alex, David, Sarah, Adrian, content-approval`
  (`apps/orchestrator-worker/src/graph.ts`). Sarah and Adrian run **after**
  Alex, so Alex never sees their output.
- No code in `apps/` writes their output into the generated project. The
  control API only returns it as artifacts (`apps/control-api/src/repository.ts`).
- Alex's instructions (`packages/agents/src/manifests.ts`) contain no
  marketing or sales requirement: no landing page, lead form, CTA, metadata,
  sitemap or analytics.
- Sophia, Sarah and Adrian are skipped for `FREE` workspaces (entitlement gate
  in `graph.ts`), so staging runs very likely skip them. The workspace plan on
  staging has not been checked in the database.
- `CustomerSuccess` is registered as a manifest but not wired into the graph.

Proposed steps (A and B in one PR, C is a separate decision):

- **A. Order.** Move Sarah and Adrian after approval and before Alex, and pass
  their output to Alex. Side effect: the content-approval pause also moves
  before Alex, one extra pause for the user.
- **B. Alex instructions.** Landing page from Adrian's value proposition and
  CTA, `generateMetadata`, `sitemap.ts` and `robots.ts` from Sarah, and a lead
  form with a `Lead` model from David.
- **C. Entitlement.** Decide whether these agents are on for the staging
  workspace. This changes the plan in the database. *Founder decision.*

Risk: every new Alex rule can open a new validation failure. Try it as a
separate experiment with fresh staging runs, after repeatability is confirmed.

### 4. Release assessment: `release.blocked`
Runs finish, but the observe-only assessor reports `release.blocked` (28 issues)
because ACCESSIBILITY, E2E, PERFORMANCE, REGRESSION and SECURITY checks and
criterion evidence are never produced. Needs a Playwright and Chromium
acceptance template for the sandbox. Has a cost and template-build component.

### 5. Event replay on restored runs
After a page reload the run graph stays IDLE and Events shows 0 until new events
arrive. The SSE header root cause was fixed (PR #143), the replay of past events
was not.

### 6. Admin overview: "Active runs"
The overview shows `Active runs: 1` when it should not. Counting bug, not yet
investigated.

### 7. Wildcard certificate renewal
The wildcard certificate expires **2026-12-18**. Renew before then.
`scripts/check-preview-cert-expiry.mjs` already checks the expiry date.

### 8. Staging blockers #14 and #22
Referenced in project notes as blockers for staging. The details were not
recorded; read the issues or notes before planning. **Unverified.**

### 9. Systems other than "generate a project once" (the AI secretary)
Source: a proposal for an AI secretary for immigrant-owned service businesses
in the GTA (bilingual Persian and English, WhatsApp, Telegram, phone, CRM).

Decision already made: first make sure Genesisco is stable as a one-shot code
generation platform, then extend it. Goal: Genesisco builds systems with very
different capabilities and uses only the parts a given system needs.

What would be new:

- A durable, event-driven run kind that waits for the next message, instead of
  the current one-shot graph.
- A channel layer: WhatsApp Cloud API, Telegram Bot API, Twilio. Nothing of this
  exists today.
- Real-time voice with low latency, a different engineering domain from batch
  generation.
- An agent with limited, field-level CRM tools instead of code generation.

What already exists and can be reused: idempotent run creation, the recovery
queue, the approval gate for safe handoff to a human, per-run and daily budget
caps, and `Workspace` as the tenant boundary.

Items 3 and 9 probably need one shared design: how Genesisco chooses which
agents and stages to enable for a given kind of system. Design that once.

## Suggested order

1. Finish phase one (repeatable runs, local DB, Preview-expired state).
2. Items 7 and 8 first when their dates or blockers demand it.
3. Item 3 A and B as one experiment, then C.
4. Items 4, 5 and 6 (quality and polish).
5. Items 2 and 1 once item 3 defines what plans unlock.
6. Item 9 after the shared stage-selection design from item 3.

## Out of scope here

The Virtual Company Roundtable app has its own roadmap and repositories.

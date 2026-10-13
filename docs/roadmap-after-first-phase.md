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

Design reference for evidence-backed analysis and for pre-launch audience
simulation: see "Reference: MiroFish" below.

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

Reference examples of target systems (from a carousel of eight workflow
automations, 2026-10-11). They show the kinds of systems this item should be
able to build, not a commitment to build each one:

- AI voice call agent: answers calls, books appointments (calendar), sends a
  confirmation email, creates a CRM contact, hands off to a human. This is the
  AI secretary above. Needs items 11 and 12 and real-time voice.
- Multilingual FAQ chatbot: detects the language and answers in it from a
  knowledge base. Needs item 11.
- Lead generation: finds leads, enriches and qualifies them, sends outreach
  email, schedules follow-ups. Needs item 12 and a policy on outbound email.
- Content creation agent and viral YouTube idea generator: research, script,
  publish on a schedule. Overlaps with item 3.
- Avatar video, faceless video, and UGC ad generator from a competitor's ad:
  need a video or avatar provider, which is a separate external dependency and
  not planned. The competitor-ad analysis also raises copyright and platform
  terms questions to settle first.

Common shape of all eight: a trigger, a short chain of steps that call
external tools, and a loop or schedule. That matches the durable event-driven
run kind listed above.

Items 3 and 9 probably need one shared design: how Genesisco chooses which
agents and stages to enable for a given kind of system. Design that once.

### 10. Building other kinds of applications
Today every run produces one Next.js and Prisma web repository: Bob plans "one
generated Next.js repository", Alex's instructions are Next.js specific, the
sandbox template and validation steps (install, prisma-validate, lint,
typecheck, test, build, preview health) assume it, and the Preview is an iframe
of the running site. The only project-type variation is the client-portal
convention (`CLIENT_PORTAL_*` in `packages/agents/src/manifests.ts`).

Goal: let Genesisco build mobile and desktop applications (confirmed by the
founder), and use only the stages a given kind needs. Which of the two comes
first, and which stack for each, is not decided. *Founder decision.*

What would change, per application kind:

- A project type with its own planning and generation instructions (Bob and
  Alex), not one more convention inside the Next.js rules.
- A sandbox template with that platform's toolchain, and its own validation
  steps. A mobile app has no Prisma schema and no `next build`.
- A different Preview story. An iframe works for web; mobile may need a web
  export or an emulator, and desktop probably needs screenshots or a recorded
  session. This is the least certain part. **Unverified feasibility.**
- Route coverage and the preview-health check are web specific and must be
  skipped or replaced.

This shares its design with items 3 and 9: choose agents and stages from the
kind of system. Do not start it before that design exists, and expect each new
kind to need its own round of "one rule per failure" tuning, as the web path
did.

### 11. Knowledge retrieval and long-term memory (RAG)
Today agents see only what the run hands them: the request, upstream agent
outputs, and a snapshot of the project files (`currentFiles`). There is no
retrieval over documents and no memory that survives between runs. The stack in
use is LangGraph (with Postgres checkpoints), Zod structured outputs, and
PostgreSQL through Prisma. There is no vector store.

What it would unlock:

- Item 9: the AI secretary needs a business's own facts (services, prices,
  hours, past conversations) and per-customer memory.
- Item 3: Sophia, Sarah and Adrian are better when they can ground claims in
  stored evidence instead of one-run context.
- Later runs on the same project remembering earlier decisions.

Open questions: PostgreSQL with `pgvector` (no new service, tenant boundary
stays `Workspace`) or a separate vector database; what is stored per workspace
and for how long; how retrieved text is kept inside the per-run budget caps.
**Checked 2026-10-13:** `VECTOR` is on the allow-list of the staging Postgres
16 server and is not enabled yet; capacity on the current tier is unmeasured.
A design proposal with the data model, three retrieval depths, cost handling and
the decisions it needs is in `docs/adr/memory-and-retrieval.md`.

Design reference: MiroFish (see "Reference: MiroFish" below) builds its memory as
a typed graph with facts that can expire, which fits the changing facts of item 9.

### 12. External tools through MCP
Agents currently call nothing outside the platform: tool use is limited to
sandbox commands that the worker runs. The Model Context Protocol would let an
agent use external tools (CRM, calendar, messaging, search) through one
standard interface instead of a hand-written integration per tool.

This is the tool layer for item 9 (limited, field-level CRM tools) and could
serve item 3. Each tool connection needs per-workspace credentials, an allow
list, and an approval step for actions with side effects; none of that exists.
Do not start it before item 9 has chosen which tools it needs.

Not planned: GraphQL (REST is enough), Python services, and a second
orchestration framework next to LangGraph.

## Reference: MiroFish (read, not adopted)

Studied 2026-10-13 from the public repository `666ghj/MiroFish` (README and the
backend services' structure only; nothing was installed or run, and the quality
of its code and the accuracy of its predictions are **not verified**). It is a
multi-agent "prediction" engine: seed text becomes a graph, the graph becomes
thousands of persona agents that interact on simulated social platforms, and a
report agent writes up what happened.

Why it is not a dependency: AGPL-3.0 (changes offered over a network must be
published, and a commercial use needs a lawyer's reading first), Python while
Genesisco is TypeScript, memory held in Zep Cloud (customer data would leave our
tenancy), and its own docs warn that LLM consumption is high, against our
per-run and daily budget caps. Its agents are language models, not customers;
the Roundtable work already showed a single model playing several roles herds
and invents numbers.

Patterns worth copying, each into the item that needs it:

- **Memory as a typed graph with expiring facts (item 11).** An ontology is
  generated from the source text first, the graph is built in batches, and edges
  carry validity so retrieval can include or exclude superseded facts. An AI
  secretary needs exactly this: prices, hours and staff change.
- **Three retrieval depths (item 11).** A quick search, a broad "panorama" that
  also returns expired facts, and a deep search that first splits the question
  into sub-questions. One tool per depth is easier to budget than one retriever.
- **Memory written back from activity (items 9 and 11).** Agent actions are
  turned into episodes and queued into the graph in the background, so later
  steps remember earlier ones without blocking the run.
- **Generate long configuration in steps (agents, Alex).** Time, events, agents
  in batches, then platform settings, "to avoid failures from one very long
  output". Genesisco's runs failed the same way and were fixed one rule at a time;
  planning an outline and then producing one part at a time, with a reflection
  pass, is a candidate design for generating larger applications.
- **Plan, then write section by section with tool calls (item 3).** Its report
  agent plans an outline, then writes each section through think, call a tool,
  reflect, with every thought and tool call logged. That is a model for Sophia's
  evidence-backed market analysis, and the log matches our run events.
- **Audience simulation before launch (item 3).** Persona agents reacting to a
  landing page or message could pre-screen copy. Treat it as brainstorming, never
  as a forecast, until a test against real responses shows otherwise.

## Suggested order

1. Finish phase one (repeatable runs, local DB, Preview-expired state).
2. Items 7 and 8 first when their dates or blockers demand it.
3. Item 3 A and B as one experiment, then C.
4. Items 4, 5 and 6 (quality and polish).
5. Items 2 and 1 once item 3 defines what plans unlock.
6. Items 9 and 10 after the shared stage-selection design from item 3. Item 10
   first needs the order (mobile or desktop) and the stack chosen.
7. Items 11 and 12 together with item 9, because the AI secretary is the first
   system that needs retrieval, memory and external tools. Item 11 may also
   help item 3 earlier.

## Out of scope here

The Virtual Company Roundtable app has its own roadmap and repositories.

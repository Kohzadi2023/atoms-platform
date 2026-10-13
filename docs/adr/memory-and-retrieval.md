# ADR: Memory and retrieval (roadmap item 11)

- **Status:** Accepted, 2026-10-13, with the four decisions below taken by delegation: the founder had no preference and asked for the recommendation to be followed. Nothing is built yet; phase P0 starts from this ADR.
- **Scope:** giving agents retrieval over a workspace's own documents and a memory that survives between runs.
- **Related:** `docs/roadmap-after-first-phase.md` items 3, 9, 11 and 12, and the "Reference: MiroFish" section there.

## Context

What the code does today (checked 2026-10-13):

- An agent sees only what its run hands it: the request, upstream agent outputs and a snapshot of the project files (`currentFiles`). Nothing is retrieved and nothing survives a run except the generated files and the run's events.
- There are **no embeddings anywhere**. The model gateway (`packages/model-gateway/src/types.ts`) has `generate` and `stream` and nothing that embeds text.
- Cost control is a ledger around model calls: `BudgetedModelGateway` reserves before a call and settles to the actual cost, against a per-run budget and a per-workspace daily budget (`apps/orchestrator-worker/src/model-budget.ts`). Anything new that spends money has to go through it.
- The tenant boundary is `Workspace`. Orchestration state is LangGraph with Postgres checkpoints; the data layer is PostgreSQL through Prisma.
- Infrastructure: the staging Postgres server is a Flexible Server, version 16, Burstable `Standard_B1ms`, 32 GB. `VECTOR` is on the server's `azure.extensions` allow-list and no extension is enabled yet (read-only check on 2026-10-13). So `pgvector` is **available, not switched on**.

What needs it:

- **Item 9, the AI secretary.** It must know one business's facts (services, prices, hours, staff) and one customer's history, and those facts **change**.
- **Item 3, marketing and sales.** Sophia, Sarah and Adrian are better when a claim can be traced to stored evidence instead of one run's context.
- Later runs on the same project remembering earlier decisions (lower priority).

Not needed now: code generation (Alex) does not retrieve; the generated files are already in the run.

## Decision (proposed)

Build memory **inside the existing PostgreSQL**, with `pgvector` for similarity and Postgres full-text search for exact terms, combined by rank fusion. No new service. The pieces:

### 1. Data model

All tables carry `workspaceId` and are only reached through one repository that requires it.

| Table | Holds |
|---|---|
| `MemorySource` | One ingested document or conversation: kind, title, content hash, language, classification (may contain personal data or not), `deletedAt`. |
| `MemoryChunk` | A passage of a source: text, `tsvector`, `embedding vector(N)`, embedding model id, position. |
| `MemoryEntity` | A typed thing the facts are about (service, person, location, policy). Types come from a small per-workspace ontology generated once from the first documents, then edited by a person. |
| `MemoryFact` | `entity`, `predicate`, `object`, `validFrom`, `validTo` (null while current), `supersededById`, `sourceId`, a verbatim `quote`, `confidence`, `reviewState`. |
| `MemoryEpisode` | A queued unit of new information (a message, a tool result, a human correction) waiting to become facts. |

A fact that stops being true is **closed** (`validTo` set, `supersededById` set), never overwritten. Retrieval excludes closed facts by default and includes them only when asked, which is how "what was the price last month" stays answerable.

### 2. Retrieval: three depths, one tool each

| Tool | What it does | Cost |
|---|---|---|
| `quick` | Hybrid vector plus keyword search over chunks, top k. | One embedding call. |
| `panorama` | `quick` plus the entities and facts around the hits, including closed facts, labelled as such. No model call beyond the embedding. | One embedding call. |
| `deep` | A cheap model splits the question into at most four sub-questions, runs `quick` on each, merges and deduplicates. | One short model call plus up to four embeddings. |

Every result carries its **source id and a verbatim quote**. An agent may not state a retrieved fact without citing it, the same rule the Roundtable claim-verification pass enforces in code. A fact with no quote is not returned.

### 3. Writing memory back

Information enters through `MemoryEpisode` rows consumed by a BullMQ queue (`memory-episodes`), never on the agent's critical path. A cheap model extracts facts as structured JSON (Zod-validated, like the other agent outputs). Conflict rule: a new fact **supersedes** an existing one only when entity and predicate match and the new source is newer; any other disagreement is stored as `reviewState = NEEDS_REVIEW` and shown to a person, not resolved by the model.

### 4. Embeddings and cost

- Add an `embed` method to the model gateway, with the Gemini embedding model as the default so the provider stays the one already in use.
- Route it through the same ledger, with its own per-workspace daily embedding cap, so a large upload cannot spend the model budget. Ingestion is refused, not truncated, when the cap is hit.
- Store the model id and dimension with every vector. A model change is a re-embed job, not a silent mix.

### 5. Tenancy, privacy, deletion

- One repository function takes `workspaceId` first and applies it to every query. No cross-workspace retrieval exists, and a test that tries to read another workspace's chunk must fail.
- Row-level security as a second line of defence is an open question below.
- Deleting a `MemorySource` cascades to its chunks and facts. Sources marked as containing personal data have a retention period and are excluded from any shared evaluation set.

### 6. Where it plugs in

First consumer: a `retrieve` tool available to graph nodes with a per-call budget. The secretary run kind (item 9) is the second. It is not added to Alex's code generation.

## How we will know it works

Decided before any agent uses it, not after:

- A **golden set** per use case (for the secretary: real questions with known answers and the passage that supports each). Measured: recall at k, citation precision (the quote really supports the answer), **stale-fact rate** (answers that used a closed fact), and cost per query.
- **Mixed Persian and English** documents and questions are part of the set from the start. Multilingual embedding quality is the main thing not yet verified.
- A cross-tenant test and a deletion test are release gates, not nice-to-haves.

## Phases

| Phase | Content | Needs approval |
|---|---|---|
| P0 | Enable `pgvector` on staging; schema and migration; chunking, `embed` through the ledger; `quick` behind a flag; no agent uses it. | Yes: infrastructure (see below). |
| P1 | Facts with validity, ontology, `panorama`. | No |
| P2 | `deep`, episode queue and write-back, review state. | No |
| P3 | `retrieve` tool for Sophia and the secretary, with the golden set as the gate. | Founder: first consumer. |

## Infrastructure steps that are not mine to take unasked

1. Add `VECTOR` to the server's `azure.extensions` parameter and run `CREATE EXTENSION vector` (a configuration change on a shared server; the migration job needs the right to create it).
2. Capacity. A 768-dimension float vector is about 3 KB, so 100 000 chunks are roughly 300 MB before the index, and an HNSW index is commonly 1.5 to 2 times that. That fits a pilot on the current 2 GB instance only if memory-heavy queries are limited; the tier may need to go up. These are estimates, to be measured on real data in P0.

## Alternatives considered

| Option | Why not |
|---|---|
| A separate vector database | A new service to run and pay for, and a second tenant model to keep isolated. |
| Zep Cloud (what MiroFish uses) | Memory leaves our tenancy for an external service; customer data is the main asset here. |
| A graph database | The temporal facts fit relational tables at this scale; a graph store adds operations without a measured need. |
| Keyword search only | Misses paraphrases; kept as one half of the hybrid instead. |

## Risks and open questions

- **Fact extraction can invent facts.** Mitigation: a fact needs a verbatim quote, and conflicts go to review rather than being resolved by a model. Unverified until the golden set runs.
- **Embedding quality for Persian** is unverified, and so is whether the current Gemini key may call the embedding endpoint.
- **Row-level security** on these tables: worth the added complexity, or is the single repository enough?
- **Cost at the free plan.** Premium agents are skipped on the FREE plan; whether retrieval is a premium capability is a pricing question for item 2.

## Decisions taken (2026-10-13, by delegation)

The founder said they had no preference and told the author to go ahead with the recommendation. These are therefore the author's recommendations, recorded so they can be reversed:

1. **Enable `pgvector` on staging: yes**, immediately before the first migration is deployed, not earlier. It adds no cost, changes no existing table, and is undone by dropping the extension. The production server, when there is one, is a separate decision.
2. **First consumer: the AI secretary (item 9).** It is the use the founder actually described, and it needs exactly this memory (business facts that change, per-customer history). Sophia's evidence (item 3) comes second, since Sophia is skipped on the FREE plan and has no consumer until item 2 decides what plans unlock. Until a secretary run kind exists, the capability is built and measured on its own against the golden set.
3. **Retention and deletion:** a source is kept until the workspace owner deletes it; deleting a source deletes its chunks and facts. Sources flagged as containing personal data and conversation episodes are purged after 12 months by default. Customer documents are never used in a shared evaluation set. **These defaults are provisional until a lawyer has read them**, which the Roundtable work already lists as an open gate.
4. **Embedding provider: Gemini**, the provider already in use. Whether the current key may call the embedding endpoint is verified in P0 before anything depends on it.

## What phase P0 needs beyond the schema

Found while preparing P0: CI (`migration-matrix`), the local `compose.yaml` and `deploy/staging/compose.yaml` all run `postgres:17-alpine`, which has no `pgvector`. A migration that creates the extension would fail there. P0 therefore changes those images to the maintainers' `pgvector/pgvector` image at the same major version, in the same pull request as the migration, and the staging server gets the extension enabled before that migration is deployed.

# Atoms Platform

Validated Phase 2 checkpoint plus the current Phase 3 vertical slices for
the multi-agent coding platform. The Control API, provider-neutral OpenAI/E2B
adapters, durable Mike -> Emma -> Bob -> approval -> Alex -> David worker flow,
deterministic E2B validation, origin-isolated preview gateway, and confirmed
Supabase provisioning/migration lifecycle, fenced stale-operation recovery, and
approval-gated orphan reconciliation are implemented.
The protected Phase 3 staging workflow applies both migration paths to
PostgreSQL 17, exercises the real BullMQ scheduler against Redis, and can run
the explicitly approved Supabase -> Vault -> E2B -> approval-gated orphan
cleanup exit while emitting credential-free evidence artifacts.

## Prerequisites

- Node.js 24+
- pnpm 11+
- Docker with Compose, or compatible PostgreSQL and Redis services

## Bootstrap

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:validate
pnpm db:migrate:dev --name contract_sprint_init
pnpm verify
```

The root `pnpm prisma ...` command always uses `prisma.config.ts` and the master
schema at `packages/db/prisma/schema.prisma`.

## Workspace

- `apps/control-api`: Fastify control plane API
- `apps/orchestrator-worker`: LangGraph.js and BullMQ worker
- `apps/preview-gateway`: signed HTTP/WebSocket reverse proxy for iframe previews
- `packages/contracts`: Zod, OpenAPI, and SSE contracts
- `packages/db`: Prisma schema and PostgreSQL client
- `packages/model-gateway`: provider-neutral LLM routing
- `packages/sandbox-provider`: provider-neutral isolated execution
- `packages/preview`: HMAC preview tickets and expiring Redis target records
- `packages/database-provider`: Supabase Management API, Vault KV v2, database
  migration runner, and provider-neutral contracts
- `packages/agents`: versioned Mike, Emma, Bob, Alex, and David manifests, schemas, and
  model-backed runtime

## Orchestration behavior

- The Control API writes a run before enqueueing the versioned `RunJob` payload.
- The worker claims the run with status/control-version compare-and-swap.
- LangGraph checkpoints each job in PostgreSQL, while `AgentTask` rows make agent
  side effects idempotent across queue redelivery.
- Completed tasks are restored from their schema-validated outputs instead of
  being billed twice.
- If Mike requires plan approval, the worker pauses after Bob. An `approve`
  action resumes at Alex without repeating completed model calls.
- Alex writes files with expected-version compare-and-swap. A manual edit wins
  and produces a safe run failure instead of last-write-wins data loss.
- David writes forward-only migration/seed files with the same atomic
  compare-and-swap rule. The worker hashes `schema.prisma`, persists an immutable
  migration artifact, and discloses destructive changes before provisioning.
- Ordered events are appended with a monotonic per-run sequence for SSE replay.
- After Alex commits the immutable revision, the worker restores it into E2B
  and runs `pnpm install --frozen-lockfile`, `prisma validate`, lint, typecheck,
  tests, and build in a fixed order. A non-zero exit fails the run.
- The worker starts the built application only after every deterministic gate
  passes, verifies its local health, and emits versioned `sandbox.ready`,
  `task.progress`, and `preview.updated` events.
- E2B ingress remains private. Its traffic token is stored only in a TTL-bound
  Redis target record and is injected server-to-server by the preview gateway.
- Every preview uses a unique HMAC-signed wildcard hostname. The gateway proxies
  HTTP and WebSocket HMR while enforcing `frame-ancestors`, restrictive CSP,
  no-referrer, no-store, and permissions-policy headers.

## Phase 2 services

Configure `.env` with OpenAI, E2B, PostgreSQL, Redis, and preview values. Point a
wildcard DNS record for `*.PREVIEW_BASE_DOMAIN` at the preview gateway. For local
development, a wildcard-loopback domain such as `preview.localhost` can be used
where the browser resolves its subdomains to `127.0.0.1`.

Run the three processes separately:

```bash
pnpm --filter @atoms/control-api dev
pnpm --filter @atoms/orchestrator-worker dev
pnpm --filter @atoms/preview-gateway dev
```

Container images use the repository root as build context:

```bash
docker build -f apps/control-api/Dockerfile -t atoms-control-api .
docker build -f apps/orchestrator-worker/Dockerfile -t atoms-worker .
docker build -f apps/preview-gateway/Dockerfile -t atoms-preview-gateway .
```

See `docs/phase-2-validation-preview.md` for the lifecycle and security boundary,
and `docs/event-catalogue.md` for replayable Phase 2 event payloads.

## Phase 3 generated database

The generated database is lazy and never created by a normal agent run. After a
David artifact exists, the Control API requires an `Idempotency-Key`, the exact
`PROVISION_DATABASE` confirmation, and a separate destructive-change approval
when applicable. The private worker then reconciles/creates Supabase, polls
health, leases the database URL from Vault, and runs migrate/seed/connectivity
checks in a disposable E2B VM. The API exposes only lifecycle metadata.

Configure all of `SUPABASE_ACCESS_TOKEN`, `SUPABASE_ORGANIZATION_SLUG`,
`VAULT_ADDR`, and `VAULT_TOKEN` to enable the Phase 3 worker. If all are absent,
the Phase 1/2 worker continues normally and no generated database can be
provisioned.

See `docs/phase-3-david-database-provisioning.md` for the lifecycle, security
invariants, teardown workflow, and internal adapter contract. The HTTP contract
is also recorded in `docs/database-provider-openapi.yaml`. Scheduled recovery,
provider inventory comparison, and the private orphan-approval workflow are
documented in `docs/phase-3-database-reconciliation.md`.
The provider-backed exit procedure and evidence fields are defined in
`docs/phase-3-staging-runbook.md`.
The recorded local and clean-room results are in
`docs/phase-3-reconciliation-verification.md`.
The staging automation, protected-environment setup, exact confirmations, and
machine-readable evidence contracts are in
`docs/phase-3-staging-automation.md`.
The reproducible clean-room result and the explicit boundary between local
verification and a real staging pass are recorded in
`docs/phase-3-staging-automation-verification.md`.

After a normal agent run emits its `migrationArtifactId`, the provider-live demo
requires an explicit billable-operation opt-in:

```bash
DEMO_PROJECT_ID=<uuid> \
DEMO_ALLOW_BILLABLE_DATABASE=true \
pnpm demo:phase3
```

The demo resolves the latest validated David artifact automatically;
`DEMO_MIGRATION_ARTIFACT_ID` can pin a specific artifact.

Set `DEMO_DESTROY_DATABASE=true` only when the same demo should also queue the
confirmed teardown workflow.

With an existing workspace UUID and all three services running, the interactive
demo creates a project/run, streams SSE, requests plan approval when needed, and
prints the signed preview URL:

```bash
DEMO_WORKSPACE_ID=<uuid> pnpm demo:phase2
```

## Verification

```bash
pnpm verify
pnpm db:validate
```

Database-backed integration tests require PostgreSQL and Redis. Unit tests use
in-memory collaborators and do not call OpenAI or E2B. A live E2B smoke run is
credential-gated and is intentionally not represented as passing when no
`E2B_API_KEY` is available.

The manual `Phase 3 staging evidence` workflow is the only supported full exit
entry point. A local or CI run with live flags absent records the PostgreSQL,
Redis, Supabase, Vault, and E2B gates as skipped—not passed.

# Atoms Platform

Validated Phase 2 checkpoint plus the current Phase 3 vertical slices for
the multi-agent coding platform. The Control API, provider-neutral OpenAI/E2B
adapters, durable Mike -> Emma -> Bob -> approval -> Alex -> David worker flow,
deterministic E2B validation, origin-isolated preview gateway, and confirmed
Supabase provisioning/migration lifecycle, fenced stale-operation recovery, and
approval-gated orphan reconciliation are implemented. The browser-to-agent
attachment slice adds encrypted S3-compatible quarantine, ClamAV inspection,
immutable run snapshots, and provider-neutral OpenAI file/image inputs.
The protected Phase 3 staging workflow applies both migration paths to
PostgreSQL 17, exercises the real BullMQ scheduler against Redis, and can run
the explicitly approved Supabase -> Vault -> E2B -> approval-gated orphan
cleanup exit while emitting credential-free evidence artifacts.

## Prerequisites

- Node.js 24+
- pnpm 11+
- Docker with Compose, or compatible PostgreSQL, Redis, S3, and ClamAV services

## Bootstrap

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:validate
pnpm db:migrate:deploy
pnpm db:seed:local
pnpm verify
```

Before starting the application, configure the provider keys and one
authentication mode in the untracked `.env` file. For the local seeded user,
generate one random token with at least 32 characters and assign the same value
to `AUTH_DEV_ACCESS_TOKEN` and `NEXT_PUBLIC_CONTROL_API_ACCESS_TOKEN`. Keep
`AUTH_DEV_AUTHENTICATOR_ENABLED=true`; never reuse or deploy that token.

The root `pnpm prisma ...` command always uses `prisma.config.ts` and the master
schema at `packages/db/prisma/schema.prisma`.

## Workspace

- `apps/control-api`: Fastify control plane API
- `apps/web`: responsive Next.js Agent Hub and project workspace
- `apps/orchestrator-worker`: LangGraph.js and BullMQ worker
- `apps/preview-gateway`: signed HTTP/WebSocket reverse proxy for iframe previews
- `packages/contracts`: Zod, OpenAPI, and SSE contracts
- `packages/db`: Prisma schema and PostgreSQL client
- `packages/model-gateway`: provider-neutral LLM routing
- `packages/sandbox-provider`: provider-neutral isolated execution
- `packages/preview`: HMAC preview tickets and expiring Redis target records
- `packages/storage-provider`: S3-compatible encrypted objects, MIME/hash
  inspection, and ClamAV adapter
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
- Browser attachments upload to tenant-scoped quarantine keys with signed URLs.
  A fenced BullMQ worker validates exact size, detected MIME, SHA-256, and
  ClamAV status before exposing an immutable clean snapshot to a run.
- Only Emma receives clean file/image inputs. Bob, Alex, and David consume the
  structured PRD, avoiding repeated file-token cost across the graph.
- If Mike requires plan approval, the worker pauses after Bob. Approvals are
  explicit and scoped: `approve` must include `approvalScope` (`plan` or
  `content`) so one approval cannot silently bypass another gate.
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

## Authentication and workspace authorization

The Control API now enforces authenticated bearer tokens on every endpoint
except `/healthz` and `/readyz`.

- Token verification is strict OIDC/JWT with JWKS signature validation.
- Required claim checks include issuer, audience, expiration, and subject
  (`sub`). Not-before (`nbf`) is validated when the issuer supplies it;
  Supabase access tokens may omit that optional claim.
- Unsigned or unverified tokens are rejected.
- The internal user ID is derived from the verified `sub` claim.
- Cross-workspace resource requests are non-enumerating and return `404`.
- Known-workspace role violations return structured `403` errors.

New identity endpoints:

- `GET /v1/me`
- `GET /v1/workspaces`
- `GET /v1/workspaces/:workspaceId`

Auth configuration placeholders are documented in `.env.example`:

- `AUTH_REQUIRED`
- `AUTH_ISSUER_URL`
- `AUTH_AUDIENCE`
- `AUTH_JWKS_URL`
- `AUTH_ALLOWED_ALGORITHMS`

Production identity is provided by Supabase Auth. Configure the project with an
asymmetric signing key (ES256 is recommended), then set:

- `AUTH_ISSUER_URL=https://<project-ref>.supabase.co/auth/v1`
- `AUTH_AUDIENCE=authenticated`
- `AUTH_JWKS_URL=https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`
- `AUTH_ALLOWED_ALGORITHMS=ES256` (or the single asymmetric algorithm actually
  selected for the project)
- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_STORAGE_ORIGIN` for the exact presigned attachment data plane

The web app uses the Supabase browser client for password sign-in, automatic
session refresh, local-session sign-out, and short-lived access-token delivery
to REST and SSE requests. Browser session state gates only the user experience;
the Control API independently verifies every JWT and applies workspace roles.
The publishable key is safe for a public client, but secret and service-role
keys must never use a `NEXT_PUBLIC_` variable.

Because Next.js embeds `NEXT_PUBLIC_*` values during compilation, container
builds must pass the five public settings as build arguments. The web Dockerfile
declares arguments for the Control API URL, Supabase URL, Supabase publishable
key, attachment storage origin, and preview base domain. The generated Content
Security Policy permits browser connections only to the exact API, Supabase,
and storage origins.

Atoms is invite-only. A Supabase user's UUID (`sub`) must match the `userId` of
an existing `memberships` row before a workspace is visible. This keeps account
creation separate from tenant and role assignment.

The static development authenticator is disabled by default. To use the local
seeded workspace, generate a random token of at least 32 characters and set
`AUTH_DEV_AUTHENTICATOR_ENABLED=true`, `AUTH_DEV_ACCESS_TOKEN=<token>`,
`AUTH_DEV_USER_ID=local-demo-user`, and
`NEXT_PUBLIC_CONTROL_API_ACCESS_TOKEN=<same-token>` in an untracked local env
file. The `NEXT_PUBLIC_*` token is browser-visible and is rejected by production
builds. Outside development, missing or partial Supabase browser configuration
fails closed and the workspace is not rendered.

See `docs/control-api-security-matrix.md` for route-to-role permissions,
workspace isolation behavior, and error semantics.

Configure `.env` with OpenAI, E2B, PostgreSQL, Redis, S3-compatible storage,
ClamAV, and preview values. Point a
wildcard DNS record for `*.PREVIEW_BASE_DOMAIN` at the preview gateway. For local
development, a wildcard-loopback domain such as `preview.localhost` can be used
where the browser resolves its subdomains to `127.0.0.1`.

Validate the root `.env` without printing any configured value, then start all
four processes with that environment:

```bash
pnpm dev:check
pnpm dev
```

The Agent Hub is then available at `http://localhost:3000`; the Control API and
preview-gateway health endpoints are available at `http://localhost:3001/healthz`
and `http://localhost:3002/healthz`. `pnpm dev` loads the repository-root `.env`
before Turbo starts package-local processes. To inspect only the frontend shell
without starting the API, worker, or gateway, run `pnpm dev:web`.

For process-level troubleshooting, each service can still be started separately
after exporting the root `.env` into that shell:

```bash
pnpm --filter @atoms/control-api dev
pnpm --filter @atoms/orchestrator-worker dev
pnpm --filter @atoms/preview-gateway dev
pnpm --filter @atoms/web dev
```

The web workspace calls only the configured Control API origin, reconnects SSE
with `Last-Event-ID`, embeds previews only on the configured signed preview
domain, and appends manual file edits with expected-version compare-and-swap.
Set `CONTROL_API_CORS_ORIGINS` to the exact web origins; wildcards are not used.

Container images use the repository root as build context:

```bash
docker build -f apps/control-api/Dockerfile -t atoms-control-api .
docker build -f apps/orchestrator-worker/Dockerfile -t atoms-worker .
docker build -f apps/preview-gateway/Dockerfile -t atoms-preview-gateway .
```

The provider-neutral staging deployment contract is in
`deploy/staging/compose.yaml`. It runs all application and persistence services
on one Docker host, keeps every application and infrastructure port private,
and publishes only the Caddy HTTP/HTTPS ingress. Caddy routes the exact
web/API/storage names and wildcard signed previews with an externally issued certificate.
Prisma migrations run before application rollout, and runtime credentials stay
in permission-restricted files outside the repository. Validate a populated
deployment contract before any build or rollout:

```bash
pnpm staging:deploy:preflight -- \
  --env-file /etc/atoms/staging/staging.env \
  --secrets-dir /etc/atoms/staging/secrets
pnpm staging:deploy:compose:validate -- \
  --env-file /etc/atoms/staging/staging.env \
  --secrets-dir /etc/atoms/staging/secrets
```

After the Issue #22 live gates are recorded, bootstrap the external PostgreSQL,
Redis, and MinIO volumes plus the migration state with an explicit change
ticket and confirmation. The command refuses a dirty or revision-mismatched
checkout and writes no passing evidence unless dependency health, bucket
initialization, `prisma migrate deploy`, and `prisma migrate status` all pass:

```bash
pnpm staging:deploy:persistence:bootstrap -- \
  --env-file /etc/atoms/staging/staging.env \
  --secrets-dir /etc/atoms/staging/secrets \
  --change-ticket GH-22 \
  --evidence-out /var/lib/atoms/staging/evidence/persistence-bootstrap.json \
  --confirmation BOOTSTRAP_ATOMS_STAGING_PERSISTENCE
```

See `docs/staging-deployment.md` for the public-env allowlist, secret-file
contract, persistence bootstrap, Compose commands, rollback boundary, and the
Issue #22 gates that must be recorded before a live deployment.
The explicitly gated two-identity live acceptance run is documented in
`docs/staging-authenticated-smoke.md`.

See `docs/phase-2-validation-preview.md` for the lifecycle and security boundary,
`docs/secure-attachments.md` for the upload/scan/model-input boundary, and
`docs/event-catalogue.md` for replayable Phase 2 event payloads.

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

For an audit-ready summary of the current repository-backed verification state,
including the actual demo scripts and the repository-wide test outcome, see
`docs/phase-4-verification.md`.

For a step-by-step operator checklist to execute blocked Step 5 staging-live
validation safely, see `docs/phase-3-step5-staging-checklist.md`.

The manual `Phase 3 staging evidence` workflow is the only supported full exit
entry point. A local or CI run with live flags absent records the PostgreSQL,
Redis, Supabase, Vault, and E2B gates as skipped—not passed.

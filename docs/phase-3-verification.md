# Phase 3 checkpoint verification

This file records the initial David/provisioning slice. The subsequent
reconciliation and orphan-safety checkpoint is recorded in
`docs/phase-3-reconciliation-verification.md`.

Verification date: 2026-08-01

The source-only checkpoint was extracted into a new directory with no
`node_modules`, `dist`, generated Prisma client, or Turbo cache. The following
commands passed from that extracted archive:

```bash
pnpm install --frozen-lockfile
pnpm run ci:verify
```

## Recorded result

| Gate | Result |
| --- | --- |
| Frozen pnpm install | Passed; 11 workspace projects including the root |
| Turborepo build | 10/10 packages passed from zero cache |
| Turborepo type-check | 10/10 packages passed from zero cache |
| Tests | 55 discovered; 53 passed, 0 failed, 2 explicitly skipped |
| Prisma 7 schema validation | Passed |
| SQL/security lint | Passed for 4 migration files |
| Dependency audit | No known vulnerabilities |
| Secret scan | Passed for 151 text files |

The skipped tests are the live E2B smoke and the live, potentially billable
Supabase provision/health/destroy smoke. They require explicit opt-in flags and
credentials. They are reported as not run, not as successful provider evidence.

## Environment boundary

This runtime did not expose PostgreSQL, Redis, OpenAI, E2B, Supabase, or Vault
credentials and did not provide a local Docker/PostgreSQL daemon. Therefore:

- the real provider adapters and durable state transitions are covered by
  deterministic contract tests;
- the new Prisma migration is schema-valid and a CI migration matrix is defined;
- applying the migration to an actual PostgreSQL upgrade database and running
  the billable Supabase/E2B flow remain provider-environment gates.

The CI `migration-matrix` job applies Phase 1+2 followed by Phase 3 to an upgrade
database, then applies the complete migration pack to a second empty PostgreSQL
17 database. A checkpoint must not be described as fully staging-validated until
that job and the explicitly enabled live provider smoke tests have run.

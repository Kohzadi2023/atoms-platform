# Phase 3 reconciliation checkpoint verification

Verification date: 2026-08-01

## Source-tree result

`pnpm run ci:verify` passed in the authoritative repository.

| Gate | Recorded result |
| --- | --- |
| Turborepo build | 10/10 packages passed |
| Turborepo type-check | 10/10 packages passed |
| Tests | 61 discovered; 59 passed, 0 failed, 2 explicitly skipped |
| Prisma 7 schema validation | Passed |
| SQL/security lint | Passed for 5 migration files |
| Dependency audit | No known vulnerabilities |
| Secret scan | Passed for 163 files in the composite gate; 164 after this report was added |

The two skipped tests are the credential-gated live E2B smoke and the explicit,
potentially billable Supabase provision/health/destroy smoke. They were not run
and are not represented as provider evidence.

## Source-only clean-room result

The source archive excluded `node_modules`, `dist`, Turbo caches, generated
Prisma Client output, and TypeScript build-info files. It was extracted under a
new path and verified independently.

| Gate | Clean-room result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed for all 11 workspace projects |
| Lockfile supply-chain policy | Passed for 346 entries |
| Forced build (`--force`) | 10/10 passed; 0 cached |
| Forced tests (`--force`) | 59 passed, 0 failed, 2 skipped; 0 cached |
| Forced type-check (`--force`) | 10/10 passed; 0 cached |
| Prisma validation | Passed |
| SQL/security lint | Passed for 5 migration files |
| Dependency audit | No known vulnerabilities |
| Secret scan | Passed for 163 post-build text files |

The finalized source-only archive was also scanned before extraction and passed
for its 137 text files; generated/build outputs account for the larger counts
above.

The clean-room composite command was decomposed into its exact constituent
gates with Turbo/Prisma telemetry disabled because the execution sandbox
intercepted an unsolicited network-initialization request. No verification gate
was omitted.

## Covered reconciliation behavior

- operation-version fencing and legacy version-zero job compatibility;
- stale recovery dispatch and maximum recovery attempts;
- worker termination at the next rejected heartbeat CAS;
- single active reconciliation sweep;
- organization- and naming-scoped Supabase inventory;
- missing-resource and orphan observations;
- report-only default behavior;
- two-observation and grace-period deletion boundaries;
- explicit orphan approval contract;
- active-sweep cleanup claim and adoption recheck;
- cleanup-claim release after provider failure;
- absence of provider secrets from contracts, events, findings, and reports.

## Environment boundary

This runtime exposes no Docker, PostgreSQL client/server, Redis server, OpenAI,
E2B, Supabase, or Vault credentials. Therefore it did not:

- apply the new migration to a running PostgreSQL upgrade database;
- execute the BullMQ scheduler against a live Redis instance;
- inventory, create, migrate, or delete a real Supabase project;
- execute a live E2B migration sandbox.

The CI PostgreSQL 17 migration matrix now applies Phase 1/2, both Phase 3
migrations in order, and the complete migration pack from empty. The exact live
staging evidence procedure is documented in `docs/phase-3-staging-runbook.md`.
Until those provider-backed jobs run, this checkpoint is implementation- and
clean-room-verified, not fully staging-validated.

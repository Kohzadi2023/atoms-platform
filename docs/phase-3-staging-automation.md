# Phase 3 staging automation

This slice turns the Phase 3 exit runbook into executable, fail-closed staging
gates. It does not claim a live pass by itself: PostgreSQL/Redis evidence is
created only on a service-backed runner, and provider evidence is created only
after protected-environment approval and explicit billable/destructive input.

## Automated gates

| Surface | Real dependency | Proof |
| --- | --- | --- |
| Phase 2 -> Phase 3 upgrade | PostgreSQL 17 | ordered Prisma migration history |
| Empty install | second PostgreSQL 17 database | full pack current |
| Sweep ownership | PostgreSQL partial unique index | one `started`, one `locked` |
| Recovery scheduling | Redis + BullMQ | one scheduler delivery and `operationVersion=1` job |
| Orphan default | PostgreSQL + reconciler | OPEN finding, zero deletes |
| Provider scope | Supabase Management API | count-only org/name exclusion audit |
| Generated DB | Supabase + Vault | one new managed resource and opaque secret refs |
| Migration | E2B | fixed install/migrate/seed/status command reports |
| Orphan cleanup | Supabase + PostgreSQL | two observations and approved state sequence |
| Teardown | Supabase + Vault | exact owned resource absent and inventory baseline restored |
| Variable cost | operator measurement | integer CAD micros at or below CAD 4 target |

The durability integration uses an isolated fake provider inventory with real
PostgreSQL and Redis so ordinary CI cannot create a billable resource. The
protected provider exit then uses the real Supabase adapter, Vault adapter, E2B
adapter, Prisma repository, and reconciler together.

## Workflow safety boundary

The manual workflow requires all of the following before provider access:

1. workflow input `RUN_PHASE3_STAGING`;
2. `run_live_provider=true`;
3. exact destructive input
   `PROVISION_MIGRATE_AND_DESTROY_SUPABASE_STAGING_DATABASE`;
4. normalized change-ticket identifier;
5. measured CAD cost no greater than 4, with at most six decimals;
6. approval of the protected `phase3-staging` GitHub Environment;
7. all Supabase, Vault, and E2B credentials present only in that job;
8. count-only cross-organization and customer-project inventory controls.

The live test generates its operation ID internally. It records only a SHA-256
fingerprint of the external resource ID. A resource visible before the scenario
is never considered owned and is never deleted by the harness.

## Evidence files

`phase3-durability-evidence.json` records the workflow run URL, commit SHA,
PostgreSQL version, migration paths, scheduler/CAS result, and report-only
orphan result.

`phase3-provider-evidence.json` is validated by
`Phase3ProviderStagingEvidenceSchema`. A `PASSED` record requires all ten gates,
one created and one deleted resource, restored inventory, no errors, a resource
fingerprint, and measured cost within target. The schema rejects PostgreSQL
URLs, bearer-shaped authorization material, and private-key markers.

Both files are retained as workflow artifacts for 30 days. Provider test
failure still uploads any evidence produced after resource ownership was
established, allowing cleanup incidents to be audited without exposing raw
credentials.

## Local behavior

Normal `pnpm test` discovers but skips the PostgreSQL/Redis integration and the
provider exit. The durability test additionally requires
`DEDICATED_EPHEMERAL_DATABASE`; the provider exit requires the exact live and
destructive confirmations. Setting only one flag is insufficient.

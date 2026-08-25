# Phase 3 staging automation verification

Recorded: 2026-08-01

This checkpoint implements the executable staging exit gates for Phase 3. It
does not record a live provider pass. No Supabase project, Vault secret, or E2B
sandbox was created during this verification because the environment-scoped
staging credentials and live confirmations were not available in the local
runner.

## Reproducible results

The repository was copied without dependencies or generated build output, then
installed and verified from its committed lockfile in a clean directory.

| Gate | Result |
| --- | --- |
| Root frozen install | passed; 11 workspaces and 346 lockfile entries |
| Build | passed; 10/10 tasks, zero cache hits |
| Type-check | passed; 10/10 tasks, zero cache hits |
| Test discovery | 69 tests |
| Test result | 65 passed, 0 failed, 4 credential/service-gated skips |
| Prisma 7 schema validation | passed |
| SQL/security lint | passed for 5 migration files |
| Dependency audit | no known high-severity-or-greater vulnerabilities |
| Secret scan | passed; 149 packaged text files and 176 working-tree text files including generated output |
| Generated-app fixture install | frozen install passed |
| Generated-app fixture Prisma validation | passed |
| Workflow/input syntax | JSON and YAML parsing passed |
| Fail-closed cost preflight | valid input passed; over-CAD-4 input rejected |

The top-level verification wrapper reached its network-backed dependency audit
through the sandbox transport once, so the deterministic gates and the audit
were also run separately. Every constituent gate above passed.

## Intentional skips

The four skipped tests are executable guards, not recorded passes:

1. live E2B adapter smoke test;
2. legacy Supabase adapter smoke test;
3. PostgreSQL/Redis durability integration scenario;
4. full Supabase/Vault/E2B provider-exit scenario.

The PostgreSQL/Redis scenario is wired into the staging/CI service matrix and
requires a dedicated ephemeral database confirmation. The full provider exit
is available only through the `phase3-staging` environment and also requires
the exact solo-operator, billable, and destructive confirmations described in
the runbook.

## What constitutes a live Phase 3 exit

Phase 3 is staging-validated only after a controlled, environment-scoped
workflow run produces both artifacts from real dependencies:

- `phase3-durability-evidence.json` from PostgreSQL 17 and Redis 8; and
- a schema-valid `phase3-provider-evidence.json` whose ten gates are all
  `PASSED`, inventory returns to baseline, one owned resource is deleted, and
  measured cost remains at or below CAD 4.

Workflow definitions, local unit tests, skipped live tests, or credentials
present without the exact live confirmations are not substitutes for those
artifacts.

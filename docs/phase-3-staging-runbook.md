# Phase 3 staging evidence runbook

This runbook defines the provider-backed exit evidence that cannot be produced
without a PostgreSQL/Redis environment and explicit Supabase/E2B/Vault access.
It separates non-destructive verification from billable or destructive steps.

## 1. Migration matrix

Run either the ordinary CI `migration-matrix` job or the manual
`Phase 3 staging evidence` workflow against PostgreSQL 17. It must:

1. apply the Phase 1/2 migration pack;
2. upgrade in order through David provisioning and reconciliation migrations;
3. report `prisma migrate status` as current;
4. apply the full migration pack to a second empty database;
5. report the second database as current.
6. start Redis and execute the real BullMQ job scheduler, operation-version
   recovery job, PostgreSQL partial unique sweep lock, and report-only orphan
   observation test.

The manual workflow writes `phase3-durability-evidence.json` and uploads it with
the job logs. Schema validation alone is not a substitute for this gate.

## 2. Non-destructive scheduler and fencing scenario

Use an isolated staging workspace and set orphan cleanup to `false`.

1. Provision a supported generated database through the confirmed Control API.
2. Stop the database-operation worker after the provider resource exists but
   before the next durable transition.
3. Advance the persisted heartbeat beyond `DATABASE_STALE_AFTER_MS` or wait for
   the configured threshold.
4. Restart the worker and wait for the scheduled reconciliation sweep.
5. Verify one new versioned recovery job, an incremented recovery count, and a
   successful READY transition.
6. Verify the fenced job cannot update state after losing `operationVersion`.
7. Verify only one provider project exists for the operation.

Evidence: sweep summary, database-instance version/recovery fields, BullMQ job
IDs, redacted events, and provider project count. No credential, Vault value, or
database URL may appear in the attachment.

## 3. Inventory isolation scenario

The provider token must be able to see:

- the configured staging organization;
- a second organization containing a project whose name starts with `atoms-`;
- a customer-created project inside the staging organization.

Run one sweep and verify that only strict platform-managed names inside the
configured `organization_slug` enter the normalized inventory. Neither control
project may create a reconciliation finding.

## 4. Approval-gated orphan scenario

This scenario creates and deletes a live provider resource and therefore needs
an explicit staging change ticket and cost approval.

1. Dispatch `.github/workflows/phase3-staging.yml` with
   `run_live_provider=true` from an approved change ticket.
2. Type both exact confirmations: `RUN_PHASE3_STAGING` and
   `PROVISION_MIGRATE_AND_DESTROY_SUPABASE_STAGING_DATABASE`.
3. After the protected `phase3-staging` environment reviewer approves access,
   the test creates one platform-pattern resource in the isolated staging
   organization and migrates the locked fixture through Vault and E2B.
4. Leave normal worker cleanup disabled; the test runs two report-only sweeps.
5. Verify an OPEN finding, two observations, and zero delete requests.
6. The staging harness advances only its isolated audit clock beyond the test
   grace boundary and records the private approval with the exact
   `APPROVE_ORPHAN_DATABASE_DELETION` contract.
7. Run one cleanup-enabled reconciler only inside the protected test.
8. Verify the finding moves `APPROVED -> CLEANING -> RESOLVED`, the exact
   provider resource is absent, and unrelated resources remain present.
9. Revoke both the ephemeral migration lease and persistent staging connection
   reference. The worker's normal cleanup switch remains `false` throughout.

If the approval-gated cleanup path fails, the harness makes one emergency
teardown attempt for the exact resource it proved was absent from the baseline
inventory, marks the evidence `FAILED`, and never converts that fallback into a
passing result.

## 5. Failure and recovery scenarios

| Fault | Required evidence |
| --- | --- |
| Supabase list returns 429/5xx | sweep FAILED; no missing/orphan decision |
| Redis rejects recovery enqueue | fenced instance FAILED with retryable diagnostic |
| Two schedulers overlap | one sweep RUNNING; second result `locked` |
| Provider delete fails | finding returns from CLEANING to APPROVED |
| Worker dies while CLEANING | abandoned sweep FAILED; next sweep releases claim |
| Resource becomes tracked before delete | cleanup claim rejected; no delete request |
| Recovery limit reached | `RECOVERY_EXHAUSTED`; no further auto-dispatch |

## 6. Exit record

Record exact values rather than a generic pass statement:

| Gate | Required value |
| --- | --- |
| PostgreSQL upgrade migration | pass/fail + job URL |
| PostgreSQL empty migration | pass/fail + job URL |
| Recovery scenarios passed | count/total |
| Orphan safety scenarios passed | count/total |
| Cross-organization isolation | pass/fail |
| Live Supabase/E2B smoke | pass/fail/not run |
| Provider resources created/deleted | exact count |
| Maximum successful-build variable cost | measured CAD amount |
| Secret scan | pass/fail |

A checkpoint is staging-validated only when every mandatory row has real
evidence. `not run` is an acceptable local-development report but is not a
staging pass.

## 7. Protected workflow setup

Create a GitHub Environment named `phase3-staging`, require a reviewer, and
disable self-approval. Configure only that environment with:

| Kind | Name |
| --- | --- |
| Secret | `SUPABASE_ACCESS_TOKEN` |
| Secret | `VAULT_ADDR` |
| Secret | `VAULT_TOKEN` |
| Secret | `E2B_API_KEY` |
| Variable | `SUPABASE_ORGANIZATION_SLUG` |
| Variable | `SUPABASE_MANAGEMENT_API_URL` |
| Variable | `VAULT_KV_MOUNT` and optional `VAULT_NAMESPACE` |
| Variable | optional `E2B_TEMPLATE` |
| Variable | `PHASE3_STAGING_MIN_OTHER_ORG_CONTROLS` (default `1`) |
| Variable | `PHASE3_STAGING_MIN_CUSTOMER_CONTROLS` (default `1`) |

Before approval, prepare at least one visible project in another organization
and one customer-named project in the staging organization. The provider exit
records count-only inventory evidence and fails before provisioning if either
control is missing. It never writes provider IDs, names, tokens, database URLs,
or Vault values to the evidence artifact.

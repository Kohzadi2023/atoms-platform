# Staging recovery rehearsal

This is Issue #22 implementation split 5. It creates the final operational
handoff only after the persistence bootstrap and authenticated staging smoke
have both passed for the exact deployed revision. It does not provision a
host, configure DNS, call OpenAI/E2B/Supabase management APIs, or replace the
live staging data volumes.

The command is intentionally disruptive. Run it only in an approved staging
maintenance window. Application writers and ingress are briefly stopped for a
cross-service-consistent backup and again while PostgreSQL, Redis, MinIO, and
ClamAV restart. The four application images are then rehearsed on the retained
previous revision before the current revision is restored.

## Required state

Before running the rehearsal:

- Issue #14 has passing live-provider evidence or its approved exception is
  recorded.
- The complete staging stack is healthy and externally reachable over HTTPS.
- `ATOMS_IMAGE_TAG` is the full SHA of the clean checkout and deployed images.
- The previous full Git SHA is an available ancestor of `ATOMS_IMAGE_TAG`.
- All four previous application images remain on the host:
  `atoms-control-api`, `atoms-orchestrator-worker`, `atoms-preview-gateway`, and
  `atoms-web`.
- The mode-`0600` persistence-bootstrap and authenticated-smoke evidence files
  use the same SHA and change ticket and contain every required passing gate.
- No agent run is active. Durable run, queue, and object-storage witnesses from
  the authenticated smoke must be present.
- The backup and evidence parent directories already exist on a protected
  filesystem. The requested backup directory and evidence file must not exist.

The GitHub Actions run ID is recorded as an operator-supplied audit reference.
The script validates its numeric shape but does not authenticate to GitHub or
claim that the referenced run belongs to the deployed SHA. Verify that mapping
in GitHub before supplying the ID.

## Protected data boundary

The backup directory contains real staging database, Redis, and attachment
data. It is created once with mode `0700`; backup files are mode `0600`. Never
place this directory in source control, CI artifacts, a public object store, or
the staging secrets directory. Apply the approved encryption, retention, and
access-control policy to it after the rehearsal.

Restore validation never targets the live volumes. It creates resources whose
names begin with `atoms-recovery-`:

- one internal Docker network with no published ports;
- isolated PostgreSQL, Redis, and MinIO volumes;
- isolated restore containers using the pinned images from the staging
  manifest.

The temporary containers, network, and volumes are removed after validation.
Cleanup failure makes the entire rehearsal fail.

## Live command

Use three independent, exact confirmations. The previous SHA must identify the
immediately retained application revision, not an arbitrary historical build.

```bash
pnpm staging:deploy:recovery:rehearse -- \
  --env-file /etc/atoms/staging/staging.env \
  --secrets-dir /etc/atoms/staging/secrets \
  --bootstrap-evidence /var/lib/atoms/staging/evidence/persistence-bootstrap.json \
  --smoke-evidence /var/lib/atoms/staging/evidence/authenticated-smoke.json \
  --backup-dir /var/lib/atoms/staging/backups/recovery-gh-22 \
  --evidence-out /var/lib/atoms/staging/evidence/recovery-rehearsal.json \
  --previous-revision <full-previous-git-sha> \
  --ci-run-id <successful-main-ci-run-id> \
  --change-ticket GH-22 \
  --restart-confirmation RESTART_ATOMS_STAGING_SERVICES \
  --backup-restore-confirmation BACKUP_AND_RESTORE_ATOMS_STAGING_IN_ISOLATED_RESOURCES \
  --rollback-confirmation ROLLBACK_AND_RETURN_ATOMS_STAGING_APPLICATIONS
```

## Passing sequence

The command fails closed unless every phase succeeds:

1. Run the secret-safe deployment preflight and verify the clean current SHA,
   previous-revision ancestry, exact confirmations, and prerequisite evidence.
2. Confirm the full stack revision and external Web/API HTTPS health.
3. Stop application writers, create a PostgreSQL custom-format dump, consistent
   Redis RDB snapshot, and MinIO object mirror in the protected backup
   directory, then restore and verify the current stack in a `finally` path.
4. Restore all three backups into isolated resources and compare aggregate
   database, queue, and object witnesses without recording tenant data.
5. Stop ingress/application services, restart persistent services, and prove
   the durable witnesses remain unchanged before restoring the current stack.
6. Recreate only the four application services with the previous images using
   `--no-build --no-deps`, verify revision labels and external HTTPS health,
   then restore and re-verify the current revision.
7. Write one redacted, mode-`0600` evidence file and retain the protected
   backups for the approved retention workflow.

Database migrations are never reversed. PostgreSQL, Redis, and MinIO live
volumes are never renamed, replaced, deleted, or attached to restore
containers. A one-version rollback passes only when the previous application
images are healthy against the already-forward-migrated schema.

## Failure behavior and evidence

Failure emits no passing evidence. If restart or rollback fails after stopping
or replacing application containers, a `finally` path restores the current
revision and verifies its labels and external HTTPS health. If that recovery
also fails, the command reports an explicit current-stack recovery error.

The backup directory is retained on both success and failure; automatic backup
deletion would remove diagnostic or recovery material. Temporary restore
resources are always removed. Inspect and remove any resource with the exact
failed rehearsal prefix only after the failure is understood.

Passing evidence contains the change ticket, current/previous SHAs, CI run ID,
verified prerequisite schemas, logical pass/fail gates, and boolean durability
claims. It excludes secrets, credentials, tokens, filesystem paths, public
URLs, presigned capabilities, tenant identifiers, Docker resource names, and
backup contents.

This command makes no billable provider call by design, but it causes staging
downtime and creates a full protected backup. Those operational impacts still
require the maintenance-window approval represented by the three exact
confirmations.

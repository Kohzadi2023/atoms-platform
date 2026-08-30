# Authenticated staging smoke

This is Issue #22 implementation split 4. It validates the deployed HTTPS
system through the same browser-visible boundaries used by a real invited user.
It does not provision a host, configure DNS, create Supabase users, or deploy
the stack. Complete the provider gate in Issue #14 (or record its approved
exception), persistence bootstrap, rollout, DNS, and TLS before running it.

The command creates one staging project, one text attachment, and exactly one
live OpenAI/E2B agent run. It does not automatically delete them. Those durable
records are operational evidence and may be removed later only under the
staging retention policy.

## Identity fixture

Create two dedicated, invite-only Supabase test users and corresponding Atoms
memberships:

- the primary identity must be `OWNER` or `ADMIN` in the smoke workspace;
- the foreign witness must belong to a different workspace and have access to
  one pre-existing project in that workspace;
- the primary identity must not be a member of the witness workspace.

Store only these values in
`/etc/atoms/staging/secrets/authenticated-smoke.env`:

```text
ATOMS_SMOKE_PRIMARY_EMAIL=<dedicated-test-email>
ATOMS_SMOKE_PRIMARY_PASSWORD=<dedicated-test-password>
ATOMS_SMOKE_FOREIGN_EMAIL=<different-dedicated-test-email>
ATOMS_SMOKE_FOREIGN_PASSWORD=<different-dedicated-test-password>
ATOMS_SMOKE_FOREIGN_PROJECT_ID=<existing-foreign-project-uuid>
```

The owner-only secrets directory remains mode `0700`; this file must be a
regular, non-symlink mode-`0444` file. Do not put these values in
`staging.env`, shell arguments, tickets, logs, or source control.

## What passes

The smoke test fails closed unless every check succeeds:

1. Web, API health/readiness, HSTS, security headers, exact CORS, and
   unauthenticated `401` behavior.
2. Supabase password authentication for both dedicated identities.
3. Primary memberships, primary `404` access to the foreign project, and a
   successful foreign-witness read proving the resource really exists outside
   the primary tenant.
4. Project creation and a presigned attachment upload through the exact public
   storage origin, followed by quarantine scanning, `CLEAN`, and a byte-identical
   signed download.
5. One live seven-agent run, a deliberately interrupted SSE connection,
   replay with `Last-Event-ID`, and compare-and-swap approvals in `plan` then
   `content` scope.
6. Durable artifacts from Mike, Emma, Bob, Alex, David, Sarah, and Adrian.
7. A ready signed preview on the configured wildcard domain with HSTS,
   `no-store`, `nosniff`, `no-referrer`, and a CSP that permits framing only by
   the exact web origin.
8. Final `COMPLETED` run state and write-once redacted evidence.

## Live command

Run from the exact clean revision recorded by `ATOMS_IMAGE_TAG`. The evidence
parent directory must already exist, must not traverse symlinks, and the target
file must not exist.

```bash
pnpm staging:smoke:authenticated -- \
  --env-file /etc/atoms/staging/staging.env \
  --secrets-dir /etc/atoms/staging/secrets \
  --change-ticket GH-22 \
  --evidence-out /var/lib/atoms/staging/evidence/authenticated-smoke.json \
  --confirmation RUN_AUTHENTICATED_ATOMS_STAGING_SMOKE \
  --provider-confirmation I_ACCEPT_ONE_LIVE_OPENAI_E2B_STAGING_RUN \
  --max-cost-cad 4
```

The positive maximum cost, capped at CAD 4, is an operator audit boundary. It
is not a provider-side hard spending limiter. Check the relevant provider
budgets and account state before supplying the confirmation.

Evidence is created once with mode `0600`. It contains the revision, change
ticket, approved audit boundary, passed logical gates, attachment byte/hash
proof, approval scopes, and agent names. It intentionally excludes credentials,
JWTs, emails, workspace/project/run/attachment identifiers, provider/customer
identifiers, public origins, presigned storage URLs, and the signed preview
hostname. A failed run emits no passing evidence.

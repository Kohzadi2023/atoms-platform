# Authenticated staging smoke

This is Issue #22 implementation split 4. It validates the deployed HTTPS
system through the same browser-visible boundaries used by a real invited user.
It does not provision a host, configure DNS, create Entra users, or deploy
the stack. Complete the provider gate in Issue #14 (or record its approved
exception), persistence bootstrap, rollout, DNS, and TLS before running it.

The command creates one staging `CLIENT_PORTAL` project, one text attachment,
and exactly one live OpenAI/E2B agent run. It does not automatically delete
them. Those durable records are operational evidence and may be removed later
only under the staging retention policy.

## Identity fixture

Use two dedicated Entra External ID test users with corresponding Atoms
memberships. Acquire a fresh Control API access token for each through the
registered Web/MSAL sign-in flow using the `access_as_user` delegated scope:

- the primary identity must be `OWNER` or `ADMIN` in the smoke workspace;
- the foreign witness must belong to a different workspace and have access to
  one pre-existing project in that workspace;
- the primary identity must not be a member of the witness workspace.

The smoke workspace may be on `FREE`, `PRO`, or `MAX`. The smoke creates its
project explicitly as `CLIENT_PORTAL`. That project type requires Mike, Emma,
Bob, Alex, and David and intentionally does not route Sophia, Sarah, or Adrian,
so its required capability set is independent of `Workspace.plan`. The harness
does not mutate the workspace plan and does not pretend that a different plan
is configured. A future smoke project type that contains premium capabilities
must supply a verified workspace plan before its capability route can be
evaluated.

Store only these values in
`/etc/atoms/staging/secrets/authenticated-smoke.env`:

```text
ATOMS_SMOKE_PRIMARY_ACCESS_TOKEN=<fresh-primary-Entra-Control-API-JWT>
ATOMS_SMOKE_FOREIGN_ACCESS_TOKEN=<fresh-foreign-Entra-Control-API-JWT>
ATOMS_SMOKE_FOREIGN_PROJECT_ID=<existing-foreign-project-uuid>
```

The owner-only secrets directory remains mode `0700`; this file must be a
regular, non-symlink mode-`0444` file. Do not put these values in
`staging.env`, shell arguments, tickets, logs, or source control.

The file is checked only by the full authenticated-smoke preflight. Normal
service deployment does not require operator tokens. Deliver the tokens through
the approved private secret-delivery mechanism. Do not supply ID tokens,
refresh tokens, client secrets, or Supabase passwords. The harness does not
refresh credentials; obtain tokens with enough remaining lifetime for the
bounded run. Expired or invalid tokens cause the API check to fail.

Local checks validate token format only. Control API performs signature,
issuer, audience and expiry verification on both `/v1/me` requests before any
resource write. Distinct token strings are insufficient: both responses must
resolve to different user IDs. Membership fixtures should use the verified
identity from `/v1/me` (Entra `oid` in the current runtime).

## What passes

The smoke test fails closed unless every check succeeds:

1. Web, API health/readiness, HSTS, security headers, exact CORS, and
   unauthenticated `401` behavior.
2. Control API authentication of both operator-supplied Entra access tokens.
3. Primary memberships, primary `404` access to the foreign project, and a
   successful foreign-witness read proving the resource really exists outside
   the primary tenant.
4. Creation of a `CLIENT_PORTAL` project and a presigned attachment upload
   through the exact public storage origin, followed by quarantine scanning,
   `CLEAN`, and a byte-identical signed download.
5. One live agent run, a deliberately interrupted SSE connection, replay with
   `Last-Event-ID`, and compare-and-swap plan approval. A content approval is
   not expected because `CLIENT_PORTAL` does not route the growth-copy
   capability/Adrian.
6. Capability routing rather than an agent-count assertion: durable artifacts
   must cover product planning (Mike), requirements/architecture (Emma),
   implementation (Bob), validation (Alex), and data design (David), and must
   not contain agents outside that project-type route. This is the live G6
   assertion that Sophia, Sarah, and Adrian are skipped by design.
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
ticket, project type, approved audit boundary, passed logical gates, attachment
byte/hash proof, approval scopes, required capability names, and the agents
that covered those capabilities. It intentionally excludes credentials, JWTs,
emails, workspace/project/run/attachment identifiers, provider/customer
identifiers, public origins, presigned storage URLs, and the signed preview
hostname. A failed run emits no passing evidence.

Current evidence adds `identityProvider: ENTRA_EXTERNAL_ID`, the
`entra_control_api_identity` check, and the G6 `project_capability_routing`
check to the existing v1 envelope. Historical v1 evidence without those fields
is not equivalent evidence. This test consumes previously acquired access
tokens; it does not itself prove the browser's interactive sign-in or redirect
flow.

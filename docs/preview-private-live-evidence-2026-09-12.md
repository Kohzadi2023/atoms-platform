# Private Preview Gateway live evidence: 2026-09-12

Status: **v17 full-image rollout and v18 private live-session smoke PASSED**,
based on operator-provided PowerShell transcripts. No Azure requests were made
while recording this result. The pasted v18 console output and full transcript
describe the same execution, not two independent successful runs.

## Artifact and execution identity

| Item | Recorded value |
| --- | --- |
| Subscription | Atoms-Staging, `2ac8ed24-166b-4325-89dc-829d64391ce9` |
| Resource group / environment | `atoms-staging-rg` / `atoms-staging-env` |
| Gateway | `atoms-staging-preview-gateway` |
| Source SHA | `b7947fa783f45b0dcbf96036f0313ba387812da9` |
| ACR build | Existing successful run `cxg`, reused by v17; no build in v18 |
| Image | `atomsstaging91ce9.azurecr.io/preview-gateway@sha256:5b23a82293be920654d9c65b95d4ebfa9ea9bb2601045698d17375b9d8f69d0b` |
| Historical CI baseline | [Full-main CI #174](https://github.com/Kohzadi2023/atoms-platform/actions/runs/34709196072), verified by the live scripts |
| v17 execution | 2026-09-12 21:10:57 to 21:18:36, operator transcript clock |
| v18 execution | 2026-09-12 22:27:14 to 22:34:43, operator transcript clock |
| v18 checkpoint directory ID | `469ea24d804e468891e2603c7eef1110` |
| Delivered v18 script SHA-256 | `377a8215148bf9c707cb4fcbdc2bf42cc1a32235e5d5d23b733d98398be91d17` |

Transcript timestamps do not include an explicit UTC offset and are not
converted to UTC here. The script hash identifies the delivered local artifact;
the pasted runtime log itself does not report a file hash. The successful v18
checkpoint is `recovery-checkpoint.json` in the operator's temporary directory
`atoms-preview-private-live-session-v18-469ea24d804e468891e2603c7eef1110`.
Raw logs, signed hosts, fixture session IDs, credentials and private IPs are not
included in this record.

## What passed

| Gate | Live result | Evidence scope |
| --- | --- | --- |
| v12 private DNS repair | Existing zone attached to the exact Redis PE; DNS/TLS/AUTH/PONG passed | Historical infrastructure repair; zone group intentionally persists |
| v17 full-image rollout | Exact digest deployed with explicit `oss-cluster` mode | Production package and non-root entry point verified |
| v17 read-only runtime | Exact private DNS, validated TLS, cluster PONG and read-only store passed | Existing secret-backed configuration used inside the replica |
| v17 health | Local health and ephemeral same-environment Job required HTTP 200 and exact `{"status":"ok"}` | Job deletion verified; internal health request performed after configured min replicas returned to zero |
| v18 signed HTTP | GET/query and POST/body forwarded through the live Gateway | Real signing/store code; temporary loopback upstream inside the exact replica |
| v18 headers | Upstream received the header stored in the fixture session | Response framing/cache header assertions also passed; caller override behavior was not separately exercised |
| v18 WebSocket | HTTP 101 with accept header and bidirectional byte forwarding | Upgrade tunnel with a mock echo upstream; not a browser or full WebSocket frame-conformance test |
| v18 Redis TTL | One random `atoms:preview:<uuid>` key used the production store's PX expiry, initial TTL at most 60 seconds | TTL shortened to two seconds; automatic expiration observed with GET returning null |
| v18 cleanup | DEL followed by GET(null); probe file removed and clients closed | This fixture was verified absent; no scan or deletion of unrelated keys |
| Final replica configuration | Exact ready revision; configured min/max `0/1` | Configuration restored; this does not assert the instantaneous running replica count is zero |
| Final isolation | Internal HTTPS only, private Redis, no public preview DNS/TLS/routes | Verified by the scripts at completion |
| Final auth/execution | `AUTH_REQUIRED=true`, `RUN_EXECUTION_ENABLED=false`, `/readyz=200`, unauthenticated `/v1/me=401` | OpenAI/E2B/provider execution absent; no secret values exposed in reported output |

v18 made a temporary scale/revision-suffix change and one TTL-bounded fixture
write. It preserved the image, Redis mode, identities and secret references.
The successful result requires neither image rollback nor another smoke run.

## Coverage that remains separate

- Invalid/tampered/expired ticket rejection, missing/revoked sessions, and
  origin-override rejection have local/CI coverage; v18 did not execute those
  negative paths in Azure. Redis key expiration is not proof of the HTTP
  response to an expired ticket or a request after session deletion.
- The signed session requests used localhost with a signed Host header. They
  did not test signed-host routing through ACA ingress. The separate v17 Job
  tested the internal ingress path for `/healthz` only.
- One random session exercises its actual Redis cluster route. It does not
  prove every shard, cluster failover, resharding or sustained load behavior.
- A mock loopback upstream does not establish E2B connectivity, provider
  execution, worker/BullMQ readiness, or a user run from UI to completion.
- Public preview remains blocked because an owned domain and wildcard TLS
  path have not been configured.

The bounded next runtime gate is [v19 private rejection behavior](preview-private-rejection-v19.md),
prepared and tested offline under the same execution-disabled boundary. Its
live result is pending. Public/provider enablement remains a separate decision.

## PR #62 disposition and repository follow-up

[PR #62: fix(staging): probe Preview Gateway health with ephemeral job](https://github.com/Kohzadi2023/atoms-platform/pull/62)
is **merged and closed**. GitHub metadata checked on 2026-09-13 reports merge
time `2026-09-12T15:40:20Z` and merge commit
`e4a051d62496ff651350826b1b13a78fb372f79c`. Its PR record includes successful
post-merge main CI #170. No new merge or closure was performed for this record.

At the live checkpoint, its repository script still pinned the old skeleton
image. This follow-up explicitly re-baselines that pin to the verified full
digest and cluster mode, retaining image, ownership, cleanup and isolation
checks. Offline tests reject the old image, tag-only image references, digest
disagreement and nonclustered mode. The updated health script's live result
remains untested; v17's health Job is separate evidence.

This follow-up preserves the operator-run v17/v18 scripts byte for byte in
`scripts/`, adds portable offline harnesses and runs them in CI. Hash assertions
protect their published contents. v19 adds its readable in-container source,
an exact embedded-source comparison, native argv checks and local rejection
tests. CI never invokes a live script entry point with `-Apply`.

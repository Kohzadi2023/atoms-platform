# Private Preview Gateway live evidence: 2026-09-13

Status: **v19 private HTTP/WebSocket rejection smoke PASSED**, based on the
operator-provided PowerShell transcript. This completes the rejection gate
prepared in [PR #65](https://github.com/Kohzadi2023/atoms-platform/pull/65),
following the [successful v17/v18 executions](preview-private-live-evidence-2026-09-12.md).
No Azure request was made while recording this evidence.

## Artifact and execution identity

| Item | Recorded value |
| --- | --- |
| Subscription | Atoms-Staging, `2ac8ed24-166b-4325-89dc-829d64391ce9` |
| Gateway | `atoms-staging-preview-gateway` |
| Source SHA pinned by the script | `b7947fa783f45b0dcbf96036f0313ba387812da9` |
| Existing ACR run | `cxg`; no build/push/image deployment performed by v19 |
| Image | `atomsstaging91ce9.azurecr.io/preview-gateway@sha256:5b23a82293be920654d9c65b95d4ebfa9ea9bb2601045698d17375b9d8f69d0b` |
| Historical image CI baseline | [Full-main CI #174](https://github.com/Kohzadi2023/atoms-platform/actions/runs/34709196072), all five jobs verified by the live script |
| Invocation | `atoms-staging-preview-gateway-private-rejection-smoke-v19.ps1 -Apply` |
| Execution | 2026-09-13 06:15:36 to 06:20:34, operator transcript clock |
| PowerShell | Core 7.6.6 on Windows |
| Checkpoint directory ID | `7781435d5f4049e092ac7de17091e609` |
| Delivered v19 script SHA-256 | `87d8f97f7106926be1e0e1fd4cb39366a4303a157480918e5e2ce5021a006535` |

The transcript has no explicit UTC offset; its clock is not converted to UTC.
The delivered-file hash identifies the preserved repository artifact. The
runtime transcript does not itself report a file hash. Its checkpoint is
`recovery-checkpoint.json` in the operator's temporary directory
`atoms-preview-private-rejection-v19-7781435d5f4049e092ac7de17091e609`.
Raw logs, workstation/user identifiers, signed hosts, fixture keys, credentials
and private IPs are not reproduced here.

## What passed

| Gate | Reported live result |
| --- | --- |
| Artifact and topology | Exact deployed image, source/run `cxg`, `oss-cluster` mode, private Redis, approved PE in the same VNet and existing DNS zone group verified before and after execution |
| Exact replica | Probe executed inside the script-owned revision/replica/container, with no prior-revision fallback |
| Carrier | Three non-secret chunks; encoded length 4484; longest command 1795 characters under the enforced 1800 ceiling |
| Positive control | Valid session forwarded through the live Gateway; caller header overrides replaced with stored/expected headers |
| Unsigned, tampered and wrong-domain tickets | HTTP and WebSocket Upgrade requests rejected with 401 |
| Expired signed ticket | HTTP and WebSocket Upgrade requests rejected with 410 |
| Valid ticket for missing or revoked session | HTTP and WebSocket Upgrade requests rejected with 404 |
| Origin override | Absolute URL, authority and backslash-authority request targets rejected with 400 for HTTP and WebSocket Upgrade |
| Upstream isolation | Rejected requests caused no selected or decoy loopback fixture contact |
| Redis fixture | One random key, initial PX TTL at most 60 seconds; explicit revocation; DEL followed by GET(null) verified absence |
| Completion proof | Complete nonce-bound success signals, probe cleanup and client closure required by the unchanged v19 script |
| Final replica configuration | Configured min/max restored to `0/1` on the exact image; ready final revision verified |
| Final network state | Gateway internal HTTPS only; Redis public network disabled; no public preview domain/TLS/routes |
| Final auth/execution state | `AUTH_REQUIRED=true`, `RUN_EXECUTION_ENABLED=false`, `/readyz=200`, unauthenticated `/v1/me=401`; no OpenAI/E2B/provider execution reported |

The transcript ends with `PRIVATE HTTP/WEBSOCKET REJECTION SMOKE SUCCEEDED`
after restoration and final boundary checks. This is a successful execution;
it does not require rollback, another v19 attempt or a new script version.
Configured minimum zero does not assert that the instantaneous running replica
count was zero at transcript completion.

## Evidence boundaries and remaining work

- v18 established positive GET/POST and WebSocket byte forwarding plus actual
  Redis key expiration. v19 adds rejection and explicit session revocation;
  these remain separate observed executions.
- Requests went through the deployed Gateway over localhost with a signed Host
  header and loopback upstream fixtures. They do not prove signed-host routing
  through ACA ingress, browser/wildcard TLS or a real provider upstream. The
  v17 ephemeral Job separately proved internal ingress `/healthz`.
- One session's real Redis cluster operations do not establish every shard,
  failover, resharding, sustained load, or worker/BullMQ readiness.
- Public preview remains blocked without an owned domain and wildcard TLS.
  Provider/run execution remains disabled; this result does not authorize
  enabling it.
- The re-baselined repository internal-health script has offline coverage;
  v19 does not newly execute that script. Its existing v17 Job evidence remains
  distinct. No repeat live health run is needed to record this checkpoint.

[CI #175](https://github.com/Kohzadi2023/atoms-platform/actions/runs/34751113810)
passed all six jobs on PR #65 commit
`cb001e2bdf5a8660098285b42da3892bc9f7f02c`, including the offline Windows job.
That CI result verifies repository tests, while the supplied v19 transcript is
the separate live Azure evidence. The documentation follow-up preserves all
three delivered v17/v18/v19 script files unchanged. PR review/merge is the
remaining repository step; the private runtime gates recorded here are complete.

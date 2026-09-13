# Private Preview Gateway rejection gate v19

Status: **LIVE SMOKE PASSED on 2026-09-13**, based on the operator-provided
06:15:36 to 06:20:34 PowerShell transcript. See the
[v19 evidence record](preview-private-live-evidence-2026-09-13.md) for artifact
identity, observed results, cleanup and coverage limits. This follows the
successful [v17/v18 executions](preview-private-live-evidence-2026-09-12.md).
This gate requires no owned domain or public exposure. It is not a
provider-backed run or a public-preview release gate.

## Scope

The standalone script is
`scripts/atoms-staging-preview-gateway-private-rejection-smoke-v19.ps1`.
It pins the successful v17/v18 full-image digest, source SHA and CI #174;
reconciles ACR run `cxg`, private Redis/PE/DNS metadata and the existing Gateway
identity/configuration; and rechecks Control API auth and execution boundaries.

| Action | Bound |
| --- | --- |
| Gateway mutation | Only min replicas/revision suffix, `0 -> 1 -> 0`; exact image and `oss-cluster` retained |
| Redis mutation | One random preview session key, initial PX TTL at most 60 seconds; explicit revocation; finally DEL and GET(null) |
| Runtime fixture | Selected and decoy HTTP servers listen only on `127.0.0.1` inside the exact Gateway replica |
| Carrier | At most three staging commands plus execution; every command at most 1800 characters; compressed payload hash verified before execution |
| Exec transport | Exact revision/replica/container; bounded 404 retry; no 429 retry; fixed nonce-bound output parsed across stdout/stderr |
| Secret use | Existing Redis URL and signing secret used inside the replica only; no secret copied into a Job or retrieved by host PowerShell |
| Failure recovery | Restore configured min/max `0/1` in finally; preserve unrelated drift rather than overwriting it; checkpoint for host interruption |

No ACR build/push, image rollout, public ingress/domain/DNS/TLS, OpenAI/E2B,
provider execution or unrelated Redis key operation is performed. No pipeline
automatically runs this live script.

## Acceptance

The positive control first proves that the live Gateway forwards a valid
session and replaces caller-supplied fixture/forwarding headers with the
stored header and correct signed host/protocol. It then requires:

| Candidate | HTTP | WebSocket Upgrade |
| --- | --- | --- |
| Unsigned host | 401 | 401 |
| Tampered signature | 401 | 401 |
| Wrong domain | 401 | 401 |
| Expired signed ticket | 410 | 410 |
| Valid ticket for absent session | 404 | 404 |
| Absolute URL, authority path, backslash authority path | 400 | 400 |
| Revoked session with still-valid ticket | 404 | 404 |

HTTP errors must have the expected sanitized JSON body and `no-store`.
Every rejected request must leave the selected upstream's connection/request/
upgrade counters unchanged, and the decoy counters at zero. Success also
requires complete, unique nonce-bound proof, key cleanup, client closure, the
exact ready final revision, and revalidated safety boundaries.

This does not observe the live Gateway's individual Redis lookups or test all
cluster shards. It does not establish browser/TLS behavior, signed-host routing
through ACA ingress, real provider upstreams, or worker/BullMQ readiness.

## Operator commands for a future rerun

The recorded v19 execution succeeded, including cleanup and scale restoration.
No rerun or recovery command is required for that successful checkpoint. The
commands below are retained for a future deliberate revalidation.

Save the standalone script in Downloads. Its SHA-256 is:

```text
87d8f97f7106926be1e0e1fd4cb39366a4303a157480918e5e2ce5021a006535
```

The following sequence uses the existing staging profile and automatically
stops if the hash or read-only Azure preflight fails. No v13 checkpoint is used.

```powershell
$atomsRejectionScript = Join-Path $env:USERPROFILE "Downloads\atoms-staging-preview-gateway-private-rejection-smoke-v19.ps1"
$atomsExpectedHash = "87d8f97f7106926be1e0e1fd4cb39366a4303a157480918e5e2ce5021a006535"
if ((Get-FileHash -LiteralPath $atomsRejectionScript -Algorithm SHA256).Hash -ine $atomsExpectedHash) {
    throw "v19 file hash mismatch."
}
pwsh -NoProfile -ExecutionPolicy Bypass -File $atomsRejectionScript
if ($LASTEXITCODE -ne 0) { throw "v19 preflight failed; no apply." }
pwsh -NoProfile -ExecutionPolicy Bypass -File $atomsRejectionScript -Apply
```

Live success is only the final banner
`PRIVATE HTTP/WEBSOCKET REJECTION SMOKE SUCCEEDED`. Preserve that run's
transcript and `recovery-checkpoint.json`. If a host interruption or unconfirmed
restoration occurs, use this exact script with only
`-RecoveryCheckpoint "<path printed by that v19 attempt>"`; this restores scale
without executing the probe. Do not substitute a v17/v18 checkpoint.

## Offline maintenance

The source is `scripts/preview-smoke/v19-rejection.cjs`, also embedded in the
standalone script. Tests require them to match. Update both together; never
weaken image/identity/scope assertions to accept a failing environment.

```sh
pnpm test:preview-smoke-offline
```

This builds only the local Gateway dependencies and executes offline harnesses
for v17/v18/v19. Set `PWSH_PATH` only when PowerShell is not on PATH. The same
tests run on Linux and Windows CI. Windows also checks the actual native
ProcessStartInfo argument round trip, including the quoted carrier commands.
The Redis transport is injected in these tests; the signer, store and Gateway
are real production modules with loopback HTTP servers. Separate CI #174 image/
cluster evidence remains historical and distinct from these offline checks.

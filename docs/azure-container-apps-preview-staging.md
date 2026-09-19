# Azure Container Apps preview staging gate

This runbook records the current Azure Container Apps preview topology and the next safe staging gate. It supplements the provider-neutral Phase 2 preview design with the verified Atoms-Staging deployment state.

## Public preview live: 2026-09-19

The "Public preview gate" section below (formerly "remains a later gate") is now satisfied. A
real, owned base domain (`genesisco.io`) was acquired and connected. This
supersedes the `preview.invalid` / internal-only state recorded in the
2026-09-13 section further down, which remains for its historical evidence
value but no longer describes current state. See
[issue #59](https://github.com/Kohzadi2023/atoms-platform/issues/59) (closed)
and the [issue #22 update](https://github.com/Kohzadi2023/atoms-platform/issues/22)
of the same date for the full verification record.

- `https://www.genesisco.io` and `https://api.genesisco.io` are live with
  Azure Container Apps managed certificates (`SniEnabled`).
- `atoms-staging-preview-gateway` ingress is now **external** (changed from
  `internal`), still on target port `3002`.
- A real wildcard certificate for `*.preview.genesisco.io` was issued by
  Let's Encrypt (DNS-01 challenge, since wildcard names have no HTTP-01
  path) and uploaded to the `atoms-staging-env` environment as
  `genesisco-preview-wildcard-le`. It is bound to the preview gateway's
  literal wildcard hostname `*.preview.genesisco.io` with
  `--validation-method CNAME`. Valid through 2026-12-18 — Let's Encrypt
  certificates are 90 days, and DNS-01 has no automatic renewal path
  without either a DNS-provider API integration or repeating the manual
  TXT-record process before expiry.
- `PREVIEW_BASE_DOMAIN` changed from `preview.invalid` to
  `preview.genesisco.io` on both `atoms-staging-preview-gateway` and
  `atoms-staging-worker`.
- `CONTROL_API_CORS_ORIGINS` now includes `https://www.genesisco.io`
  alongside the original `azurecontainerapps.io` origin.
- The Entra External ID SPA app registration
  (`3be3b7af-17db-4a00-8448-04ba55fa76f0`) has
  `https://www.genesisco.io/redirect` added as a redirect URI; real
  end-to-end sign-in against the "Atoms Staging Customers" tenant through
  the new domain was verified in a browser.
- Verified the signed-ticket security model survived going public: a
  made-up subdomain (`test123.preview.genesisco.io`) completes a real TLS
  handshake against the wildcard certificate but is rejected at the
  application layer with `401 {"error":"Invalid preview URL"}` — public
  ingress alone grants no access to an actual preview session.
- `AUTH_REQUIRED=true` and `RUN_EXECUTION_ENABLED=false` remain enforced,
  unchanged.
- No mutation was made to the legacy `Pay-As-You-Go` subscription or any
  `LogiCount` resource.

**Not done by this change:** the formal `pnpm staging:smoke:authenticated`
and recovery-rehearsal evidence runs against the live domain. Those need
`RUN_EXECUTION_ENABLED=true` and real OpenAI/E2B credentials (issue #14),
which remain the sole open blocker on #22.

## Latest operator-verified state: 2026-09-13

The v17/v18 transcripts and the subsequent v19 rejection smoke establish the
state below at completion of those executions. This is recorded live evidence,
not a fresh Azure observation when reading this document. See the
[v17/v18 record](preview-private-live-evidence-2026-09-12.md) and
[v19 record](preview-private-live-evidence-2026-09-13.md).

- Subscription: `Atoms-Staging` (`2ac8ed24-166b-4325-89dc-829d64391ce9`).
- The legacy subscription `bbcaf423-9a71-43bc-9fc7-821ef012cd01` is explicitly out of scope and must never be mutated by this runbook.
- Resource group: `atoms-staging-rg`.
- Container Apps environment: `atoms-staging-env`.
- Environment default domain: `proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io`.
- Control API remains `AUTH_REQUIRED=true` and `RUN_EXECUTION_ENABLED=false`.
- Previously recorded worker baseline: provider-disabled, min/max replicas `0/1`, no ingress, provider budget `0`, and intentionally invalid OpenAI/E2B placeholders. v17/v18/v19 do not revalidate worker runtime readiness.
- Preview Gateway exists as `atoms-staging-preview-gateway` with min/max replicas `0/1`, `PREVIEW_BASE_DOMAIN=preview.invalid`, and **internal-only** ingress on target port `3002`.
- The verified internal FQDN is `atoms-staging-preview-gateway.internal.proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io`.
- Preview Gateway image is `atomsstaging91ce9.azurecr.io/preview-gateway@sha256:5b23a82293be920654d9c65b95d4ebfa9ea9bb2601045698d17375b9d8f69d0b`, from source `b7947fa783f45b0dcbf96036f0313ba387812da9`, reusing ACR run `cxg`.
- The Gateway uses explicit `PREVIEW_REDIS_MODE=oss-cluster` with the existing private Managed Redis endpoint and DNS zone group.
- Redis and preview-signing secret references are Key Vault-backed and use the staging runtime managed identity.
- No environment custom DNS suffix, environment certificate, Container App custom domain, Azure DNS public zone, or environment HTTP route config is currently configured.
- Public preview is therefore intentionally blocked.

  **Superseded 2026-09-19** — see "Public preview live" above. Ingress is
  now external with a real wildcard certificate bound; this bullet and the
  internal-only FQDN below describe the state before that change, not the
  current one.

The internal-ingress gate was executed successfully on 2026-09-11. It verified `external=false`, HTTPS-only ingress, no custom domain, no public DNS/TLS mutation, and re-checked the Control API auth/run-execution safety boundary after the change.

## Internal runtime health evidence and PR #62

The operator's v17 rollout passed both local `/healthz` and a same-environment
ephemeral health Job after restoring configured min replicas to zero. This
establishes internal health for the full-image digest above.

[PR #62](https://github.com/Kohzadi2023/atoms-platform/pull/62) merged on
2026-09-12 at `e4a051d62496ff651350826b1b13a78fb372f79c`; GitHub status was
checked on 2026-09-13. This follow-up re-baselines its repository health script
to the operator-verified full-image digest and explicit `oss-cluster` mode.
The exact image, tag-to-digest reconciliation and Job cleanup guards remain.
The re-baselined repository script has offline coverage; it has not itself
been executed live by this follow-up.

The repository v4 gate merged in PR #62 uses one ephemeral manual Container Apps Job in the same environment, not the interactive `debug`/`exec` transport. It reuses the current Control API image only as a Node runtime, copies no API secrets, and uses the existing managed identity only for ACR image pull. A JSON-form YAML file preserves JavaScript as a single argument on Windows. The job performs a bounded request to:

`https://atoms-staging-preview-gateway.internal.proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io/healthz`

Required result: HTTP 200 and the byte-exact body below, with no redirect. Job configuration is verified before execution, and deletion is independently verified before reporting success.

```json
{"status":"ok"}
```

This request may temporarily wake the Preview Gateway from scale `0` to `1`. It does **not**:

- enable external/public ingress;
- configure DNS, a custom domain, or a certificate;
- change `PREVIEW_BASE_DOMAIN` away from `preview.invalid`;
- enable run execution;
- configure or use real OpenAI/E2B credentials;
- create a preview session or contact an E2B upstream.

Before and after the probe, the script re-verifies:

- the Atoms-Staging subscription lock and forbidden legacy subscription;
- `AUTH_REQUIRED=true` and `RUN_EXECUTION_ENABLED=false`;
- Control API `/readyz=200` and unauthenticated `/v1/me=401`;
- the exact Preview Gateway image and ACR digest;
- min/max replicas `0/1`;
- internal-only ingress on port `3002`;
- no custom domain;
- no custom environment DNS suffix or certificate;
- no Azure DNS public zone;
- no environment-level HTTP route config.

## Reusable guarded health execution

The following command probes only internal health using an ephemeral Job. The
image guard now matches the successful full-image baseline. A successful v18
does not require repeating this health gate.

```powershell
& "C:\Program Files\PowerShell\7\pwsh.exe" `
  -NoProfile `
  -ExecutionPolicy Bypass `
  -File ".\deploy\staging\preview-gateway-internal-health-smoke.ps1"
```

The complete transcript is copied to the clipboard at the end.

## Public preview gate — satisfied 2026-09-19

This section originally blocked enabling public Preview Gateway ingress
until the items below were known and verified. All are now satisfied; see
"Public preview live: 2026-09-19" above for the evidence. Kept here for the
historical record of what the gate required:

- a user-owned base domain — `genesisco.io`;
- the authoritative DNS provider and ability to create the required records — Namecheap, operator-controlled;
- a wildcard routing design compatible with the single-label signed preview ticket — `<signed-ticket>.preview.genesisco.io`, matching the expected shape below;
- a valid TLS certificate path for the exact wildcard preview hostname — Let's Encrypt DNS-01 wildcard certificate, bound with `--validation-method CNAME`;
- a rollback plan for hostname/certificate binding — `az containerapp ingress enable --type internal` reverses external exposure; the certificate binding can be removed independently of DNS.

The public shape is a single dynamic signed label below the controlled preview base domain: `<signed-ticket>.preview.genesisco.io`. The real domain was operator-provided, not inferred from Azure resources or invented by automation.

## Before enabling live execution

`RUN_EXECUTION_ENABLED` is one of three locks (see `docs/adr/production-execution-gate.md`), and the Control API cannot see the worker's environment, so the worker publishes its own state and `/readyz` reports it. Do not change the flag before this check passes:

```bash
pnpm readiness:check --origin https://api.genesisco.io --for-enable
```

It only issues `GET /readyz` and exits `0` (safe to enable), `1` (a gate is failing, listed by ID, or the locks disagree) or `2` (the check could not run). Run it without `--for-enable` after the flag is on to catch a flag that is on while a precondition fails.

The gates it reports, and what makes each pass on the worker:

| Gate | Passes when |
|---|---|
| `G1` | `RUN_PROVIDER_BUDGET_USD_MICROS > 0` and `WORKSPACE_PROVIDER_BUDGET_USD_MICROS_PER_DAY > 0` |
| `G4` | the reference-attachment contract is intact (a build-time fact, no setting) |
| `G5` | `SANDBOX_EGRESS_VERIFIED_AT` holds the date the live egress probe last passed. Run `packages/sandbox-provider` live test first (`RUN_LIVE_E2B_TESTS=true E2B_API_KEY=...`). Setting the variable without the probe is a false attestation. |
| `G7` | `PREVIEW_BROWSER_VIABILITY=required`: every validated preview is loaded in a real browser inside the sandbox. Requires an `E2B_TEMPLATE` that carries Playwright and Chromium (see below). |
| `LOCK_3` | OpenAI and E2B credentials are present on the worker |

The browser check needs Playwright and Chromium inside the sandbox template. The runner looks for Playwright at `/opt/atoms-viability/node_modules/playwright/index.mjs` (override with `PREVIEW_BROWSER_PLAYWRIGHT_ENTRY`). A template build step along these lines is expected, but it has not been run: `mkdir -p /opt/atoms-viability && cd /opt/atoms-viability && npm init -y && npm install playwright && npx playwright install --with-deps chromium`. With `PREVIEW_BROWSER_VIABILITY=required` and a template lacking it, validation fails closed (exit code 3 in the `preview-health` step) rather than skipping the check.

`/readyz` stays `200` and keeps `status: "ready"`. It adds `platformReady`, `executionReady` and an `execution` block with booleans and gate IDs only, never a configured value. A worker that has not reported for 90 seconds counts as not ready.

## References

- [Azure Container Apps ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview)
- [Azure Container Apps Jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs)
- [Azure CLI Container Apps Job create](https://learn.microsoft.com/en-us/cli/azure/containerapp/job#az-containerapp-job-create)

Always re-check current Microsoft documentation before changing live ingress, custom-domain, certificate, or environment routing configuration.

## Follow-up: private Redis and application contracts

The operator's 2026-09-12 v12 transcript records a successful private Managed
Redis DNS repair: one DNS zone group on the existing PE, exact private endpoint
DNS resolution, validated TLS/AUTH/PONG, and restoration of Gateway min/max
replicas `0/1` without public exposure or provider execution.

See [private Redis IaC adoption and local Gateway contracts](preview-private-redis-and-routing.md)
for the persistent child-resource declaration, read-only adoption review, and
loopback-only routing/authentication tests. This is separate from PR #62's
internal-health probe. The v12 infrastructure result and local tests are
historical prerequisites; the later v17/v18 transcripts establish the bounded
live application coverage below.

## Full-image rollout and private live-session gate completed

CI now builds the actual production Gateway image and tests its unchanged entry
point on a disposable internal Docker network with a three-shard Redis cluster
and mock upstream. See [the private image gate](preview-private-redis-and-routing.md#packaged-image-runtime-gate).
CI itself does not publish to ACR or deploy. The operator separately completed
the v17 full-image rollout and the v18 private live-session smoke on 2026-09-12.
v18 verified signed HTTP GET/POST forwarding, stored header injection, a
WebSocket 101 handshake and bidirectional byte forwarding, and one real Redis
session key's PX TTL, expiration, deletion and absence. The upstream was a
loopback fixture inside the exact Gateway replica. The image stayed pinned and
configured min/max replicas returned to `0/1`.

The v18 checkpoint completes the positive-path private smoke. The
[v19 rejection gate](preview-private-rejection-v19.md) subsequently passed on
2026-09-13: invalid/expired tickets, missing/revoked sessions and origin-override
attempts were rejected for both HTTP and WebSocket Upgrade, with no selected
or decoy upstream contact. The positive header-override control, one-key Redis
revocation/cleanup and final `0/1` configuration also passed. Public browser/TLS,
real provider upstreams, and worker/BullMQ cluster behavior remain separate
gates. No additional Azure execution is required to record these successful
checkpoints.

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

## Incident 2026-09-20: log flood from the worker (CAD 7,313 in September)

`Atoms-Staging` cost CAD 7,313.81 month to date, CAD 7,239 of it Log Analytics, about CAD 915 a day from 2026-09-12. The worker (`atoms-staging-worker`) was logging a full stack trace for the same Redis error about 930,000 times an hour (roughly 230 GB a day into `ContainerAppConsoleLogs_CL`). The workspace had no daily cap.

**Cause.** The staging Azure Managed Redis (`Balanced_B0`) runs with the OSS cluster policy. BullMQ, which carries the run queue, the attachment scan queue and the database queues, was pointed at it as a single node:

1. With `RUN_QUEUE_PREFIX=atoms-staging` its Lua scripts touched keys in different slots: `CROSSSLOT Keys in request don't hash to the same slot`. BullMQ needs a hash-tagged prefix in cluster mode, for example `{atoms-staging}`.
2. With the prefix fixed, the next error is `MOVED 9134 10.40.1.4:8501`: a standalone client cannot follow a cluster's redirects. BullMQ needs a cluster-aware ioredis connection (or a Redis with the Enterprise clustering policy, which presents one endpoint).

Every queue-based path on staging has therefore never worked: no run, attachment scan or database operation could have been processed. The worker still looked healthy because the app itself was up. This would have failed the first live run in #14.

**What was done (2026-09-20).**

- Workspace `atoms-staging-logs` now has a **2 GB/day ingestion cap** (it was unlimited). Past the cap, ingestion stops until the daily reset.
- `RUN_QUEUE_PREFIX` on the Control API and the worker is now `{atoms-staging}` (hash-tagged). The Control API revision is `--0000007` and `/readyz` returns 200.
- The worker's active revision was **deactivated**, so the worker is not running. Nothing needs it while execution is off, except that attachment scans are not processed. `az containerapp update` on the worker creates and starts a new revision, so do not update it until the Redis connection is fixed.
- The worker now prints an unchanged error once and then at most one summary line a minute (`throttled-log.ts`), so this class of failure cannot produce another bill like this.

**The fix (code).** `@atoms/queue-connection` gives every BullMQ queue and worker, and the readiness clients, an ioredis `Cluster` connection when `QUEUE_REDIS_MODE=oss-cluster`; the default is `standalone`, which uses exactly the options the queues always used. In cluster mode each queue refuses to start unless `RUN_QUEUE_PREFIX` contains a hash tag such as `{atoms-staging}`, so the CROSSSLOT misconfiguration fails at startup with a clear message. CI now starts a three-node Redis Cluster and shows both failures (`CROSSSLOT` with an untagged prefix, `MOVED` with a plain connection) and a job flowing through a cluster connection with a tagged prefix.

**To re-enable the worker after this merges and the images are rebuilt.** Set, on top of `RUN_QUEUE_PREFIX={atoms-staging}` (already set):

- Control API: `QUEUE_REDIS_MODE=oss-cluster`
- Worker: `QUEUE_REDIS_MODE=oss-cluster` **and** `PREVIEW_REDIS_MODE=oss-cluster`. The worker's preview session store has its own setting and is `standalone` today, which would hit the same `MOVED`; the Preview Gateway already has `oss-cluster`.

Deploy the Control API first, then update the worker (which starts a new revision), and watch `ContainerAppConsoleLogs_CL` for a few minutes before leaving it: with the log cap and the throttled logger a repeat costs little, but it should not happen. Then run one queue job end to end.

**Still open.** The images have not been rebuilt or redeployed. Nothing here has run against Azure Managed Redis itself, only against a three-node open-source cluster in CI; the first real run on staging is the proof. Add an Azure Cost Management budget alert (done: `Atoms-Staging-Monthly-25CAD`, CAD 25 a month) and ask Azure billing about a one-time adjustment.

**How to look at it again.** Cost by service: Cost Management, `Atoms-Staging`, group by service name. Volume by table: `Usage | where TimeGenerated > ago(3d) | summarize GB=sum(Quantity)/1024 by DataType`. Errors: `ContainerAppConsoleLogs_CL | where ContainerAppName_s == 'atoms-staging-worker' | summarize count() by substring(Log_s, 0, 120)`.

## Minimum-cost state (from 2026-09-21) and how to bring staging back

After the incident above the owner decided: keep Azure spend at the minimum until the project is finished, and make sure nothing can raise it. Staging is therefore parked. Nothing here runs a live workload, and the site and API are effectively down (the web app wakes on a request, but the API needs Postgres and Redis).

**Parked state.**

| Resource | State | Why |
|---|---|---|
| `atoms-staging-web`, `-control-api`, `-preview-gateway` | min replicas 0 | scale-to-zero costs nothing while idle |
| `atoms-staging-worker` | no active revision | it was the loop; a running replica alone cost about CAD 2.2 a day |
| PostgreSQL `atoms-staging-pg-91ce9` | Stopped | compute is about CAD 0.5 a day; storage stays. **Azure restarts a stopped server by itself after 7 days**, first around 2026-09-28 |
| Log Analytics `atoms-staging-logs` | ingestion capped at 0.1 GB a day | the incident was 230 GB a day with no cap |
| Managed Redis `atoms-staging-redis-91ce9` and its private endpoint | **deleted 2026-09-21** (about CAD 1.35 a day together). Only the empty `privatelink.redis.azure.net` DNS zone and its VNet link remain, at a few cents | nothing in it needed to survive: queues and preview sessions are ephemeral |

What is left costs roughly CAD 1.4 a day (the Container Apps environment's load balancer about 0.78 and its IP about 0.16, the container registry about 0.21, Postgres storage about 0.2, the virtual network). Those per-resource figures are from Cost Management for 2026-09-19 and 2026-09-20, before Redis was deleted; the 2026-09-21 total was CAD 1.32 with Redis running for part of it. Read the real figure in Cost Management after a few days.

**Always name the subscription.** The `az` default on the owner's machine is often the employer subscription (`ConcentrixCX`), and `Atoms-Staging` is a different, non-default subscription of the same profile. Pass `--subscription 2ac8ed24-166b-4325-89dc-829d64391ce9` on every `az` command (or put the id in the `az rest` URL), and never use `az account set` for this work. A delete without it either does nothing or, worse, lands on the wrong subscription. That is exactly what happened to the first attempt to delete Redis.

**What keeps it parked.** A scheduled task on the owner's machine, `azure-staging-cost-guard`, runs daily at 09:08 local time and only undoes things that raise cost (start of Postgres, min replicas above 0, an active worker revision, a lifted log cap), then reports the last three daily totals. It only runs while the desktop app is open and the `az` login is valid, and it needs its first run approved by the owner. It is not a spending limit: Azure has none for this subscription.

**Do not, while parked.**

- Run `az containerapp update` on the worker: it creates and starts a new revision.
- Dispatch the "Azure staging host" workflow or any deploy: it can start compute.
- Re-enable anything before reading today's cost in Cost Management.

**Bringing it back, in this order.** Tell the owner the added cost per day before each step.

1. Postgres: `az postgres flexible-server start -g atoms-staging-rg -n atoms-staging-pg-91ce9` (about CAD 0.5 a day more).
2. Redis (deleted 2026-09-21). Recreate it with the same settings and then the private endpoint and DNS (`infra/azure/staging/main.bicep` and `managed-redis-private-dns.bicep` define them). Settings of the deleted instance: Azure Managed Redis, Canada Central, SKU `Balanced_B0`, TLS 1.2, database `default` on port 10000, clustering policy **OSSCluster**, eviction `NoEviction`, access keys enabled, no persistence or modules, private endpoint in subnet `private-endpoints` of `atoms-staging-vnet`. Then update the `redis-url` secret on the Control API, the worker and the Preview Gateway; the host name and key are new.
3. Images: the worker image in the registry (`provider-disabled-0482b37eab42`) predates the cluster-aware queue fix (#124), so rebuild and push the Control API and worker images from `main` before starting the worker.
4. Settings: on the Control API `QUEUE_REDIS_MODE=oss-cluster`; on the worker `QUEUE_REDIS_MODE=oss-cluster` and `PREVIEW_REDIS_MODE=oss-cluster`; `RUN_QUEUE_PREFIX={atoms-staging}` on both (already set). Keep `RUN_EXECUTION_ENABLED=false`.
5. Web and Control API: set min replicas back only if a warm start is needed; scale-to-zero works and is free while idle.
6. Start the worker last, watch `ContainerAppConsoleLogs_CL` for a few minutes, run one queue job end to end, then read the cost the next day.

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

The browser check needs Playwright and Chromium inside the sandbox template. The template is defined in `packages/sandbox-provider/src/viability-template.ts` and layers Playwright (pinned) and Chromium onto your existing validation template, so its Node, pnpm and packages stay as they are. Preview the plan, then build:

```bash
pnpm e2b:viability-template --base <existing-template>
E2B_API_KEY=... pnpm e2b:viability-template --base <existing-template> --build
```

The first command is a dry run and sends nothing. `--build` is billable and registers `<existing-template>-viability` (use `--name` to change it; it can never overwrite the base). Then set `E2B_TEMPLATE` to the new name and `PREVIEW_BROWSER_VIABILITY=required` on the worker. The runner looks for Playwright at `/opt/atoms-viability/node_modules/playwright/index.mjs` and Chromium under `/opt/atoms-viability/browsers` (override with `PREVIEW_BROWSER_PLAYWRIGHT_ENTRY`). **The build has not been run**: the definition is checked offline only, so the first `--build` is also the first proof that it works. With `PREVIEW_BROWSER_VIABILITY=required` and a template lacking it, validation fails closed (exit code 3 in the `preview-health` step) rather than skipping the check.

`/readyz` stays `200` and keeps `status: "ready"`. It adds `platformReady`, `executionReady` and an `execution` block with booleans and gate IDs only, never a configured value. A worker that has not reported for 90 seconds counts as not ready.

## Renewing the preview wildcard certificate

The `*.preview.genesisco.io` certificate (`genesisco-preview-wildcard-le` in `atoms-staging-env`) is from Let's Encrypt, valid 90 days, and **expires 2026-12-18**. Nothing renews it. Wildcard names need DNS-01, DNS is at Namecheap, and there is no DNS API integration (issue #93). When it expires every public preview URL fails TLS.

**Warning.** `.github/workflows/preview-cert-expiry.yml` runs weekly (Mondays 06:17 UTC) and fails when fewer than 30 days remain. It is read-only: one TLS handshake to `cert-expiry-check.preview.genesisco.io`, no credentials. GitHub emails a failed scheduled run to the person who last edited the workflow's cron line, so check that this is someone who will act; the Actions tab shows it either way. Run the same check by hand any time:

```bash
node scripts/check-preview-cert-expiry.mjs
```

**Renew at the latest two weeks before expiry.** Everything below runs on an operator's machine; none of it is automated, and none of it was exercised by the change that added this section. The last issuance used the `acme` Python library because `certbot` refused to run without Windows administrator rights, so the `certbot` commands below are the standard equivalent, not a replay of what was done. Check flags with `--help` before running.

1. **Issue a new certificate** on a machine where `certbot` can run (Linux or WSL is simplest), in a scratch directory outside the repository:

   ```bash
   certbot certonly --manual --preferred-challenges dns -d "*.preview.genesisco.io"      --config-dir ./le/config --work-dir ./le/work --logs-dir ./le/logs
   ```

   When it prints a value, add it at Namecheap as a TXT record named `_acme-challenge.preview`, wait until it resolves (`nslookup -type=TXT _acme-challenge.preview.genesisco.io`), then continue.
2. **Convert to PFX** with a password you generate and do not reuse:

   ```bash
   openssl pkcs12 -export -inkey ./le/config/live/preview.genesisco.io/privkey.pem      -in ./le/config/live/preview.genesisco.io/fullchain.pem -out preview-wildcard.pfx
   ```

3. **Upload under a new name** (never overwrite the current certificate, so it stays available for rollback):

   ```bash
   az containerapp env certificate upload --name atoms-staging-env --resource-group atoms-staging-rg      --certificate-file preview-wildcard.pfx --certificate-name genesisco-preview-wildcard-le-2
   ```

4. **Bind it** to the gateway's literal wildcard hostname:

   ```bash
   az containerapp hostname bind --name atoms-staging-preview-gateway --resource-group atoms-staging-rg      --environment atoms-staging-env --hostname "*.preview.genesisco.io"      --certificate genesisco-preview-wildcard-le-2 --validation-method CNAME
   ```

5. **Verify:** `node scripts/check-preview-cert-expiry.mjs` must report about 90 days, and a made-up subdomain must still answer `401 {"error":"Invalid preview URL"}` over TLS.
6. **Clean up:** delete `preview-wildcard.pfx` and the whole `./le` directory (they hold the private key), remove the TXT record, and only then delete the old certificate from the environment. Never commit any of these files; `pnpm secrets:scan` is a backstop, not a plan.

**Rollback.** Rebind the previous certificate name with the same `hostname bind` command.

**Automating it** (a Namecheap API key kept as a protected secret, or moving DNS to Azure DNS) is the real fix and is still open in #93. The expiry check above is what makes doing it by hand safe until then.

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

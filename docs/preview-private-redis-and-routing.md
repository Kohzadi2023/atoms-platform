# Private Redis DNS adoption and local Preview Gateway contracts

These are separate from public preview enablement and from the internal-health
ephemeral-job change in [PR #62](https://github.com/Kohzadi2023/atoms-platform/pull/62).
Neither this change nor its CI deploys Azure resources, enables run execution, or
contacts OpenAI/E2B. An owned domain is not needed for the local contract tests.

## Operator-provided live evidence: 2026-09-12

The successful `managed-redis-private-dns-repair-v12.ps1` transcript establishes:

| Boundary | Verified result |
| --- | --- |
| Managed Redis and encrypted database | Running/Succeeded; public network Disabled; port 10000 |
| Private endpoint | Approved/Succeeded; `redisEnterprise`; same VNet as Container Apps |
| Persistent repair | One `atoms-managed-redis` zone group attached to the existing `privatelink.redis.azure.net` zone |
| Zone configuration | `managed-redis`; existing direct VNet link retained; Azure-generated A records match the exact PE NIC |
| Runtime DNS | Secret/canonical hostname matches and resolves only to the exact PE private IP set |
| Runtime probes | Local `/healthz` HTTP 200, exact `{"status":"ok"}`; validated TLS; AUTH `+OK`; PING `+PONG` |
| Final safety state | Internal-only HTTPS; min/max `0/1`; `RUN_EXECUTION_ENABLED=false`; no public preview, provider calls, secret disclosure, or Redis data writes |

This evidence came from the operator's live transcript, not from a cloud
deployment performed by this PR. The deployed image remains the pinned
`private-skeleton-0482b37eab42` image recorded in the
[Container Apps runbook](azure-container-apps-preview-staging.md).
Infrastructure DNS/TLS/AUTH/PONG does **not** prove that the full application
image can retrieve sessions and proxy previews in staging.

## One-resource IaC adoption

`infra/azure/staging/managed-redis-private-dns.bicep` treats the PE and private
zone as **existing** resources and declares only their child DNS zone group.
Its fixed child/configuration names match v12 so a later incremental deployment
can adopt that repair. The existing zone may be in another resource group in
the same subscription; its resource-group name is an explicit required input.

The template does not create or modify Redis, the PE, zones, VNet links, secrets,
Container Apps, ingress, public DNS, certificates, or A records. Azure manages
the endpoint records after zone-group attachment. It is deliberately separate
from `infra/azure/staging/main.bicep`, which deploys the unrelated VM host.

CI compiles both templates with Bicep `v0.46.1` and verifies the **compiled ARM
template** contains exactly this one child resource, the correct private zone,
and no secret parameters, outputs, extra resource writes, or scope overrides.

Local compilation and verification require no Azure login:

```sh
bicep build infra/azure/staging/managed-redis-private-dns.bicep --outfile /tmp/atoms-managed-redis-private-dns.json
node scripts/verify-managed-redis-dns-template.mjs /tmp/atoms-managed-redis-private-dns.json
```

### Later adoption review; do not deploy automatically

The Bicep template does not itself validate the subscription, PE approval,
Redis target, NIC, or VNet relationship. Before any authorized adoption:

1. Lock scope to `Atoms-Staging` subscription
   `2ac8ed24-166b-4325-89dc-829d64391ce9`, PE resource group `atoms-staging-rg`.
   Never use legacy subscription `bbcaf423-9a71-43bc-9fc7-821ef012cd01`.
2. Reconcile the exact existing PE against the Running/Succeeded, private-only
   Managed Redis root; require an Approved `redisEnterprise` connection, the
   same VNet as Container Apps, and the exact PE NIC private IP set.
3. Require the exact existing `privatelink.redis.azure.net` zone, a Completed
   direct link to that environment VNet, and the v12 child/configuration names.
   Stop for a conflicting zone group, attachment, or endpoint-specific record.
4. Supply the validated PE name and zone resource group explicitly. Review an
   **incremental** what-if. After v12, expect no resource changes; any proposed
   difference requires investigation and explicit approval. Never deploy in
   Complete mode or delete the working zone group as cleanup.

The following is a read-only review command, not an apply command. Empty inputs
intentionally stop execution; do not infer a PE name from its naming pattern.

```powershell
$managedRedisPrivateEndpointName = "" # exact PE name from approved ARM metadata
$managedRedisPrivateZoneResourceGroup = "" # exact existing private zone RG
if ([string]::IsNullOrWhiteSpace($managedRedisPrivateEndpointName) -or
    [string]::IsNullOrWhiteSpace($managedRedisPrivateZoneResourceGroup)) {
    throw "Supply both validated existing-resource names before what-if."
}
az deployment group what-if `
  --subscription "2ac8ed24-166b-4325-89dc-829d64391ce9" `
  --resource-group "atoms-staging-rg" `
  --name "atoms-managed-redis-dns-adoption" `
  --mode Incremental `
  --template-file "infra/azure/staging/managed-redis-private-dns.bicep" `
  --parameters "privateEndpointName=$managedRedisPrivateEndpointName" `
               "privateDnsZoneResourceGroup=$managedRedisPrivateZoneResourceGroup"
if ($LASTEXITCODE -ne 0) { throw "Read-only DNS adoption what-if failed. Do not apply." }
```

Do not retrieve or paste `REDIS_URL`, access keys, canonical hostnames, or private
IPs into PR evidence. Keep raw ARM/what-if metadata private. No deployment or
what-if was executed while preparing this change.

## Application contracts on loopback only

Run from the repository root:

```sh
pnpm install --frozen-lockfile --filter @atoms/preview-gateway... --ignore-scripts
pnpm test:preview-private
pnpm test:staging-deployment
```

The Gateway tests create HTTP servers on `127.0.0.1` with ephemeral ports and
send a synthetic signed `Host: <ticket>.preview.invalid`. They do not perform
DNS lookups for that domain or require public ingress/wildcard TLS. They use
the production `PreviewTicketSigner` and `RedisPreviewSessionStore` with an
injected, in-memory Redis client; **no staging Redis data is read or written**.
The fake provider traffic header authenticates only the local test upstream.

Coverage includes exact health semantics independent of Redis; signed routing,
GET query/POST body forwarding and server-side header injection; unsigned,
tampered, wrong-domain, expired, missing, revoked and mismatched session
rejection; target expiry/TTL; sanitized 500/502 failures; and authenticated
WebSocket behavior and ticket rejection. Invalid tickets cannot trigger session
lookup or an upstream connection. The signed hostname is a bearer capability,
not a substitute for Control API user/workspace authorization.

The new HTTP/WebSocket regression tests also reject absolute URLs,
authority-form paths and backslash authority paths before connecting upstream.
Otherwise `new URL(request.url, target.upstreamUrl)` can override the registered
origin and forward its server-side traffic credential to a caller-selected
server. Only origin-form paths on the stored upstream are accepted.

These tests prove local application contracts, not live Redis client behavior,
Redis persistence, real E2B routing, browser wildcard TLS, or staging application
readiness. Keep the public-preview gate blocked without an owned domain/TLS
path. A later private-only full-image rollout and local/mock-upstream staging
probe needs a separately authorized deployment; this PR does not perform it.

## Packaged image runtime gate

The v11 ARM evidence reports `OSSCluster`. Unlike Enterprise clustering,
OSSCluster requires a Redis Cluster-aware client and dynamic shard discovery;
a successful seed PING is not evidence that GET/SET will route to other shards.
The preview session store now supports explicit `PREVIEW_REDIS_MODE=oss-cluster`
in both the Gateway and preview-session writer. Default `standalone` preserves
local development and nonclustered/Enterprise-policy behavior. The mode is not
inferred from a hostname. Cluster URIs must use `redis://` or `rediss://` with
database 0; credentials are decoded locally, TLS certificate verification stays
enabled, canonical SNI is preserved, and shard ports are discovered rather than
hardcoded. This changes repository code only, not staging environment values.

The Gateway Dockerfile prepares a portable production package using pnpm 11's
`deploy --prod --legacy`. An independent graph check rejects any transitive
re-resolution that differs from the frozen source build. Runtime contains only
the Gateway/preview package artifacts and their production dependencies, runs
as `node`, and starts `dist/main.js`; it no longer copies the whole monorepo.

Full CI adds a separate `preview-runtime-integration` job:

- Resolve `deploy/ci/compose.preview-runtime.yaml` and verify its exact seven
  services, isolated project, internal network, no public ports, host env files,
  secrets, privileged mode, application overlay or entry-point override.
- Build the actual Dockerfile locally on the runner. No image login, push,
  ACR publish, Azure workflow or deployment occurs.
- Start three ephemeral Redis 8 shards (no persistence), the unchanged Gateway
  entry point and an authenticated mock HTTP/WebSocket upstream.
- Require the exact health body, production-only dependency resolution, signed
  GET/POST/query/body routing across every shard, server-owned header injection,
  and a reproducible `MOVED` failure from the original standalone-client form.
- Require unsigned/tampered/wrong-domain/expired/missing/revoked session rejection,
  HTTP/WebSocket origin-override rejection without upstream contact, authenticated
  Upgrade byte forwarding, and actual Redis PX TTL/automatic expiration.
- Delete only generated fixture keys, close clients, require clean SIGTERM exit,
  and always remove only the job-owned Docker containers/network. No staging
  Redis data is read or written; no OpenAI/E2B API is used.

This is a Linux CI-only local image gate, not a staging rollout. Plain Redis in
the fixture proves client cluster routing; unit tests check `rediss` options,
AUTH parsing and verified TLS/SNI, while v12 separately proves historical live
DNS/TLS/AUTH/PONG. Live cluster-shard DNS/ports/TLS, full application routing and
the new image have **not** been validated in Azure by this work. The worker stays
provider-disabled; BullMQ/other Redis consumers and worker cluster readiness are
separate gates, not established by preview-store tests.

Any later private-only rollout requires explicit approval for the exact source
SHA/image digest, ACR build/publish and image mutation, preservation of internal
HTTPS/min-max 0/1/execution kill switches/secrets, a bounded mock-upstream probe
with only scoped expiring fixture keys, and rollback to the current digest.
Re-baseline immutable-image smoke assertions by review rather than removing
them. Public preview remains blocked without an owned domain/wildcard TLS.

## References

- [Private endpoint DNS configuration](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns)
- [Bicep private DNS zone group schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.network/privateendpoints/privatednszonegroups)
- [Referencing existing Bicep resources](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/existing-resource)
- [Azure Managed Redis cluster policies and ports](https://learn.microsoft.com/en-us/azure/redis/architecture)
- [ioredis Cluster, TLS and discovery](https://github.com/redis/ioredis#cluster)
- [pnpm portable production deploy](https://pnpm.io/cli/deploy)

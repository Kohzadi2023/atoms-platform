# Azure Container Apps preview staging gate

This runbook records the current Azure Container Apps preview topology and the next safe staging gate. It supplements the provider-neutral Phase 2 preview design with the verified Atoms-Staging deployment state.

## Current verified state

- Subscription: `Atoms-Staging` (`2ac8ed24-166b-4325-89dc-829d64391ce9`).
- The legacy subscription `bbcaf423-9a71-43bc-9fc7-821ef012cd01` is explicitly out of scope and must never be mutated by this runbook.
- Resource group: `atoms-staging-rg`.
- Container Apps environment: `atoms-staging-env`.
- Environment default domain: `proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io`.
- Control API remains `AUTH_REQUIRED=true` and `RUN_EXECUTION_ENABLED=false`.
- Provider-disabled worker exists with min/max replicas `0/1`, no ingress, provider budget `0`, and intentionally invalid OpenAI/E2B placeholders.
- Preview Gateway exists as `atoms-staging-preview-gateway` with min/max replicas `0/1`, `PREVIEW_BASE_DOMAIN=preview.invalid`, and **internal-only** ingress on target port `3002`.
- The verified internal FQDN is `atoms-staging-preview-gateway.internal.proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io`.
- Preview Gateway image is `atomsstaging91ce9.azurecr.io/preview-gateway:private-skeleton-0482b37eab42`, digest `sha256:53b70e9f6fa2fee00af2c02d70c6d5fdc281acde31532af1c2ab7d7278c9d994`.
- Redis and preview-signing secret references are Key Vault-backed and use the staging runtime managed identity.
- No environment custom DNS suffix, environment certificate, Container App custom domain, Azure DNS public zone, or environment HTTP route config is currently configured.
- Public preview is therefore intentionally blocked.

The internal-ingress gate was executed successfully on 2026-09-11. It verified `external=false`, HTTPS-only ingress, no custom domain, no public DNS/TLS mutation, and re-checked the Control API auth/run-execution safety boundary after the change.

## Internal runtime health gate

The next gate proves that the deployed Preview Gateway can actually start and answer its unauthenticated `/healthz` endpoint through the **internal Container Apps network** before any public hostname is introduced.

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

## Guarded execution

Run:

```powershell
& "C:\Program Files\PowerShell\7\pwsh.exe" `
  -NoProfile `
  -ExecutionPolicy Bypass `
  -File ".\deploy\staging\preview-gateway-internal-health-smoke.ps1"
```

The complete transcript is copied to the clipboard at the end.

## Public preview remains a later gate

Do not enable public Preview Gateway ingress until all of the following are known and verified:

- a user-owned base domain;
- the authoritative DNS provider and ability to create the required records;
- a wildcard routing design compatible with the single-label signed preview ticket;
- a valid TLS certificate path for the exact wildcard preview hostname;
- a rollback plan for hostname/certificate binding.

The expected public shape is a single dynamic signed label below a controlled preview base domain, for example `<signed-ticket>.preview.example.com`. The real domain must not be inferred from Azure resources or invented by automation.

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
internal-health probe. Neither the v12 infrastructure result nor local contract
tests establishes a live full-application preview deployment; public preview
remains intentionally blocked.

## Next gate: full-image runtime readiness before any rollout

CI now builds the actual production Gateway image and tests its unchanged entry
point on a disposable internal Docker network with a three-shard Redis cluster
and mock upstream. See [the private image gate](preview-private-redis-and-routing.md#packaged-image-runtime-gate).
This does not publish to ACR or update the deployed private-skeleton image. The
operator's earlier health-v4/Redis-v12 logs are historical live evidence, not
proof that the current repository health gate or full application was run live.

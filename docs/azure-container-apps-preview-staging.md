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
- Preview Gateway private skeleton exists as `atoms-staging-preview-gateway` with min/max replicas `0/1`, no ingress, and `PREVIEW_BASE_DOMAIN=preview.invalid`.
- Preview Gateway image is `atomsstaging91ce9.azurecr.io/preview-gateway:private-skeleton-0482b37eab42`, digest `sha256:53b70e9f6fa2fee00af2c02d70c6d5fdc281acde31532af1c2ab7d7278c9d994`.
- Redis and preview-signing secret references are Key Vault-backed and use the staging runtime managed identity.
- No environment custom DNS suffix, environment certificate, Container App custom domain, or Azure DNS public zone is currently configured.
- Public preview is therefore intentionally blocked.

## Why the next gate is internal ingress

Azure Container Apps supports an `internal` application ingress mode. The app receives an environment-scoped FQDN and is reachable only by other Container Apps in the same environment through its own FQDN. This lets us validate the gateway resource boundary without selecting or guessing a public domain.

The next gate only enables internal ingress on port `3002`. It does **not**:

- enable external ingress;
- configure DNS, a custom domain, or a certificate;
- change `PREVIEW_BASE_DOMAIN` away from `preview.invalid`;
- enable run execution;
- configure real OpenAI/E2B credentials;
- intentionally wake the scale-to-zero Preview Gateway with a health request.

An environment-level HTTP route can target an internal-ingress app and expose it through the environment route. The guarded script therefore fails closed if any `Microsoft.App/managedEnvironments/httpRouteConfigs` resource is present in the staging resource group.

## Guarded execution

Run from a clean `main` checkout that exactly matches `origin/main`:

```powershell
& "C:\Program Files\PowerShell\7\pwsh.exe" `
  -NoProfile `
  -ExecutionPolicy Bypass `
  -File ".\deploy\staging\preview-gateway-enable-internal-ingress.ps1"
```

The script:

1. starts with `Clear-Host` and captures a transcript;
2. locks Azure CLI to the Atoms-Staging subscription and blocks the legacy subscription;
3. proves current `main` contains the accepted single-label preview-ticket baseline;
4. proves Control API auth/run-execution safety remains intact;
5. proves public DNS/TLS and environment HTTP route exposure are absent;
6. proves the exact Preview Gateway image digest, scale-to-zero settings, and `preview.invalid` configuration;
7. enables only `internal` HTTP ingress on target port `3002`;
8. verifies `external=false`, HTTPS-only, no custom domain, and an Azure internal FQDN containing `.internal.`;
9. repeats the public-routing and Control API safety checks;
10. copies the complete transcript to the clipboard.

## Public preview remains a later gate

Do not enable public Preview Gateway ingress until all of the following are known and verified:

- a user-owned base domain;
- the authoritative DNS provider and ability to create the required records;
- a wildcard routing design compatible with the single-label signed preview ticket;
- a valid TLS certificate path for the exact wildcard preview hostname;
- a rollback plan for hostname/certificate binding.

The expected public shape is a single dynamic signed label below a controlled preview base domain, for example `<signed-ticket>.preview.example.com`. The real domain must not be inferred from Azure resources or invented by automation.

## References

- Microsoft Learn: Azure Container Apps ingress overview.
- Microsoft Learn: Configure ingress for Azure Container Apps.
- Microsoft Learn: Communicate between container apps in an Azure Container Apps environment.

Always re-check current Microsoft documentation before changing live ingress, custom-domain, certificate, or environment routing configuration.

# Microsoft Entra External ID staging cutover

This runbook records the verified Atoms staging identity control-plane state and the remaining cutover sequence. The legacy Azure subscription `bbcaf423-9a71-43bc-9fc7-821ef012cd01` is explicitly out of scope and must never be selected by these procedures.

## Verified staging identity state

- Azure subscription: `Atoms-Staging` (`2ac8ed24-166b-4325-89dc-829d64391ce9`)
- Resource group: `atoms-staging-rg`
- External tenant: `atomsstaging91ce9.onmicrosoft.com`
- External tenant ID: `1dda8889-b5fc-43eb-857b-b1549e4b82c3`
- Authority: `https://atomsstaging91ce9.ciamlogin.com/`
- Control API client ID: `4299c3fb-7ce1-4d23-bd49-26c554b08dac`
- Web SPA client ID: `3be3b7af-17db-4a00-8448-04ba55fa76f0`
- Delegated API scope: `api://4299c3fb-7ce1-4d23-bd49-26c554b08dac/access_as_user`
- Web -> Control API tenant-wide delegated admin consent: granted
- OIDC issuer: `https://atomsstaging91ce9.ciamlogin.com/1dda8889-b5fc-43eb-857b-b1549e4b82c3/v2.0`
- JWKS: `https://atomsstaging91ce9.ciamlogin.com/1dda8889-b5fc-43eb-857b-b1549e4b82c3/discovery/v2.0/keys`
- Access-token signing algorithm expected by staging: `RS256`

These identifiers are public application metadata, not credentials. Do not commit access tokens, passwords, client secrets, refresh tokens, or provider credentials.

## 1. Create the customer sign-up/sign-in user flow

Run `scripts/bootstrap-entra-external-user-flow.ps1` from PowerShell 7 on the trusted staging operator workstation.

The script is intentionally fail-closed. It:

1. selects and verifies only the dedicated `Atoms-Staging` subscription;
2. rejects the legacy subscription ID;
3. validates the previously persisted `~/.atoms/entra-staging-apps.json` state against the exact tenant and application IDs above;
4. obtains delegated Microsoft Graph `EventListener.ReadWrite.All` consent for the External Tenant;
5. creates or reuses `atoms-staging-sign-up-sign-in` through Microsoft Graph v1.0;
6. configures email + password (`EmailPassword-OAUTH`) sign-up/sign-in;
7. associates only `atoms-staging-web` with the flow;
8. writes the non-secret result to `~/.atoms/entra-staging-user-flow.json`;
9. reasserts the dedicated staging Azure CLI context and copies its complete transcript to the clipboard.

The request shape follows Microsoft Graph v1.0 `POST /identity/authenticationEventsFlows`, including the supported `conditions.applications.includeApplications` association. Do not replace this with a beta endpoint unless Microsoft removes the v1.0 contract.

## 2. Runtime cutover contract

The deployed Control API must keep `AUTH_REQUIRED=true` and must use the verified External ID token metadata:

```text
AUTH_REQUIRED=true
AUTH_ISSUER_URL=https://atomsstaging91ce9.ciamlogin.com/1dda8889-b5fc-43eb-857b-b1549e4b82c3/v2.0
AUTH_AUDIENCE=4299c3fb-7ce1-4d23-bd49-26c554b08dac
AUTH_JWKS_URL=https://atomsstaging91ce9.ciamlogin.com/1dda8889-b5fc-43eb-857b-b1549e4b82c3/discovery/v2.0/keys
AUTH_ALLOWED_ALGORITHMS=RS256
```

The deployed browser must use:

```text
NEXT_PUBLIC_ENTRA_CLIENT_ID=3be3b7af-17db-4a00-8448-04ba55fa76f0
NEXT_PUBLIC_ENTRA_AUTHORITY=https://atomsstaging91ce9.ciamlogin.com/
NEXT_PUBLIC_ENTRA_API_SCOPE=api://4299c3fb-7ce1-4d23-bd49-26c554b08dac/access_as_user
```

Supabase remains a separate generated-database provider integration. Do not restore Supabase as the Atoms customer-login authority and do not remove the Supabase database-provider implementation.

## 3. Authenticated smoke gap

The browser and Control API runtime on `main` have already migrated to Microsoft Entra External ID, but `scripts/smoke-staging-authenticated.mjs` and `docs/staging-authenticated-smoke.md` still acquire their two fixture access tokens through Supabase password authentication. That harness must not be treated as Entra cutover evidence.

Before the final staging acceptance gate, migrate the smoke identity bootstrap so its primary and foreign bearer tokens are issued by the External Tenant/user flow (or supplied by an operator-controlled Entra token-capture step) while preserving the existing `/v1/me`, cross-workspace non-enumeration, attachment, SSE replay, approval CAS, preview, and redacted-evidence assertions.

Until that migration lands, a successful legacy authenticated-smoke run is not sufficient evidence for the Entra login cutover.

## 4. Acceptance order

The safe order is:

1. create/verify the External ID user flow and Web association;
2. verify the registered SPA redirect URI exactly matches the deployed Web origin;
3. deploy the Control API with the Entra issuer/audience/JWKS contract and `AUTH_REQUIRED=true`;
4. deploy the Web image built with the Entra public variables;
5. verify unauthenticated `/v1/me` remains `401`;
6. perform a real browser sign-up/sign-in and acquire `access_as_user`;
7. verify authenticated `/v1/me` succeeds and workspace authorization remains scoped;
8. run the migrated two-identity authenticated smoke;
9. only after the identity gate is green, proceed to unrelated Admin Console foundation work.

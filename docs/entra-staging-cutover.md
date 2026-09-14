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
- OIDC issuer and JWKS: use the exact `issuer` and `jwks_uri` returned by the
  external tenant's v2.0 discovery metadata. The issuer can use the tenant-GUID
  hostname even when the browser authority uses `atomsstaging91ce9.ciamlogin.com`.
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
AUTH_ISSUER_URL=<exact discovery issuer>
AUTH_AUDIENCE=4299c3fb-7ce1-4d23-bd49-26c554b08dac
AUTH_JWKS_URL=<exact discovery jwks_uri>
AUTH_ALLOWED_ALGORITHMS=RS256
```

The deployed browser must use:

```text
NEXT_PUBLIC_ENTRA_CLIENT_ID=3be3b7af-17db-4a00-8448-04ba55fa76f0
NEXT_PUBLIC_ENTRA_AUTHORITY=https://atomsstaging91ce9.ciamlogin.com/
NEXT_PUBLIC_ENTRA_TENANT_ID=1dda8889-b5fc-43eb-857b-b1549e4b82c3
NEXT_PUBLIC_ENTRA_API_SCOPE=api://4299c3fb-7ce1-4d23-bd49-26c554b08dac/access_as_user
```

Supabase remains a separate generated-database provider integration. Do not restore Supabase as the Atoms customer-login authority and do not remove the Supabase database-provider implementation.

## 3. Identity and authenticated smoke coverage

The browser and Control API runtime use Microsoft Entra External ID. Two
different smoke commands cover different parts of the cutover:

- `scripts/smoke-staging-entra-auth.mjs` reads two operator-supplied token files,
  checks the dedicated staging token metadata, and requires `/v1/me` to resolve
  two different users. It makes only identity GET requests and does not create
  projects, run agents, or prove cross-workspace isolation or browser sign-in.
- `scripts/smoke-staging-authenticated.mjs` uses the private three-variable
  Entra token fixture in `docs/staging-authenticated-smoke.md`. It retains
  cross-workspace non-enumeration, attachment, SSE replay, approval CAS, live
  agent execution, preview and redacted-evidence assertions. It requires the
  existing explicit live-run confirmations and public domain/TLS prerequisites.

Both commands rely on Control API for actual JWT verification. Neither performs
an interactive browser login. Historical Supabase-password smoke results do not
prove the Entra cutover, and passing local mocks does not prove a live smoke ran.

For the identity-only step, supply private token-file paths to:

```bash
node scripts/smoke-staging-entra-auth.mjs \
  --control-api-origin "https://api.staging.example.com" \
  --primary-token-file /absolute/private/primary.jwt \
  --foreign-token-file /absolute/private/foreign.jwt
```

Replace the example API origin with the existing deployment's HTTPS origin.

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

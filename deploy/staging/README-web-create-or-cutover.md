# Staging Web create-or-cutover

Use `entra-web-create-or-cutover.ps1` only from a clean, synchronized `main` checkout.

The script is fail-closed and:

- locks Azure CLI to the dedicated `Atoms-Staging` subscription and blocks the legacy subscription;
- verifies the previously established Entra External ID application and user-flow state;
- verifies the existing Container Apps environment, runtime managed identity, ACR, and `AcrPull` assignment;
- builds the Web image in ACR with the verified `NEXT_PUBLIC_ENTRA_*` build arguments;
- creates `atoms-staging-web` if it is missing, using the existing user-assigned managed identity for private ACR pull;
- otherwise updates only the expected staging Web app after validating its Container Apps environment;
- enforces external ingress on target port 3000 and verifies the reserved staging FQDN and HTTP 200;
- captures a transcript and copies the complete transcript to the clipboard.

The script does not change `AUTH_REQUIRED`, production auth, the legacy Azure subscription, or the Supabase generated-database provider integration.

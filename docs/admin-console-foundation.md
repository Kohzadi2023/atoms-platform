# Admin Console Foundation

## Status

Repository-side Microsoft Entra External ID rollout is now prepared on `main`. Live staging activation still requires the local guarded sequence:

1. create/verify the External ID sign-up/sign-in user flow,
2. run the guarded Control API Entra cutover,
3. rebuild/deploy Web with the verified `NEXT_PUBLIC_ENTRA_*` build arguments,
4. complete two real External ID browser sign-ins,
5. run the Entra staging identity smoke.

This document defines the Admin Console foundation without introducing a parallel auth system or weakening those gates.

## Goals

The first Admin Console increment should provide a secure operator surface for workspace administration while reusing the same Entra session and Control API authorization boundary as the main workspace.

The initial operator surface is intentionally small:

- workspace overview,
- workspace members and roles,
- projects and recent runs,
- deployment/runtime health summaries,
- database/integration status summaries,
- read-only audit-oriented operational information.

Destructive or cross-workspace actions are out of scope for the first increment.

## Non-goals

- No second identity provider or admin-specific login.
- No authorization based only on client-side claims.
- No bypass of `AUTH_REQUIRED=true`.
- No direct browser access to PostgreSQL, Supabase, Azure, provider credentials, or secret stores.
- No removal of the generated-database provider integration. `DatabaseProvider.SUPABASE`, `DatabaseProvider.NEON`, and `DatabaseProvider.EXTERNAL` remain product capabilities independent of authentication.
- No global super-admin capability until a server-side platform-role model is explicitly designed and migrated.

## Existing authorization model

The database already defines workspace-scoped membership roles:

- `OWNER`
- `ADMIN`
- `MEMBER`

The first Admin Console should build on this existing `MembershipRole` model rather than adding a second workspace-role system.

### Recommended authorization matrix

| Capability | OWNER | ADMIN | MEMBER |
| --- | --- | --- | --- |
| View workspace admin overview | yes | yes | no |
| View members | yes | yes | no |
| Change MEMBER <-> ADMIN | yes | no initially | no |
| Transfer ownership | later | no | no |
| Remove members | later | later | no |
| View project/run operational status | yes | yes | no |
| View deployment/database/integration status | yes | yes | no |
| Read secret values | never | never | never |

All checks must be enforced in the Control API. The Web may hide unavailable navigation, but UI visibility is not an authorization boundary.

## Route shape

Use a workspace-scoped route rather than a global `/admin` surface:

```text
/workspaces/:workspaceId/admin
/workspaces/:workspaceId/admin/members
/workspaces/:workspaceId/admin/projects
/workspaces/:workspaceId/admin/operations
```

This matches the existing workspace ownership model and avoids accidentally implying platform-wide authority.

## API foundation

Prefer additive, read-first endpoints under the existing authenticated Control API. Suggested first contracts:

```text
GET /v1/workspaces/:workspaceId/admin/overview
GET /v1/workspaces/:workspaceId/members
GET /v1/workspaces/:workspaceId/admin/projects
GET /v1/workspaces/:workspaceId/admin/operations
```

Every endpoint should:

1. require a valid Entra bearer token through the existing auth middleware,
2. resolve the user from the token subject using the same identity path as `/v1/me`,
3. load membership using `(workspaceId, userId)`,
4. require `OWNER` or `ADMIN`,
5. query only records scoped to that workspace,
6. return no provider credentials, secret values, access tokens, connection strings, or raw Key Vault references.

## Overview response

A minimal overview payload can be derived from existing data without schema changes:

```ts
interface WorkspaceAdminOverview {
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
  membership: {
    role: "OWNER" | "ADMIN";
  };
  counts: {
    members: number;
    projects: number;
    activeRuns: number;
  };
  operations: {
    failedRuns: number;
    activeDeployments: number;
    unhealthyDatabaseInstances: number;
  };
}
```

The exact response should be added to `packages/contracts` with Zod schemas before UI implementation.

## Web foundation

The Web Admin Console should reuse the existing Entra session boundary and access-token provider. Do not instantiate a second MSAL client for admin routes.

Recommended component split:

```text
apps/web/app/workspaces/[workspaceId]/admin/page.tsx
apps/web/src/components/admin/admin-shell.tsx
apps/web/src/components/admin/admin-overview.tsx
apps/web/src/lib/admin-api.ts
```

The auth/session layer should be refactored only as much as necessary to allow authenticated route content to reuse the current token provider. Keep the current workspace sign-in experience unchanged during the first admin increment.

## Delivery slices

### Slice 1 — read-only admin overview

- contracts for overview response,
- Control API repository query scoped by membership,
- authorization tests proving MEMBER is denied and cross-workspace access is denied,
- workspace-scoped admin route,
- loading/error/empty states,
- no mutation endpoints.

### Slice 2 — members

- list workspace members,
- display `OWNER` / `ADMIN` / `MEMBER`,
- OWNER-only role-change mutation after explicit contract and audit requirements are defined,
- regression tests preventing an OWNER from accidentally removing the final owner.

### Slice 3 — operations

- recent failed/running agent runs,
- deployment status,
- database instance status,
- integration connection status,
- links back into the existing workspace/project surfaces.

## Security acceptance criteria

Before any Admin Console mutation ships:

- staging Entra browser login is proven with the real External ID user flow,
- the Entra identity smoke passes for two distinct subjects,
- `AUTH_REQUIRED=true` remains enforced,
- MEMBER access to admin API endpoints returns 403,
- ADMIN/OWNER access is scoped to the current workspace,
- cross-workspace object IDs cannot be used to infer or mutate resources,
- API responses contain no secret material,
- CI covers authorization regression tests.

## First implementation PR after staging auth activation

The recommended first code PR is **read-only workspace admin overview** only. It should add the contract, repository query, authorization tests, Control API route, and a minimal authenticated Web route. Avoid membership mutations until the staging Entra flow is fully proven and the read-only authorization path is stable.

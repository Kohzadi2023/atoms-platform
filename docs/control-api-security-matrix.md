# Control API Authentication, Authorization, and Tenant Isolation

## Authentication boundary

- All Control API routes require `Authorization: Bearer <token>` except:
  - `GET /healthz`
  - `GET /readyz`
- Access tokens are verified with OIDC/JWT signature validation through JWKS.
- The verifier enforces:
  - Issuer (`iss`)
  - Audience (`aud`)
  - Expiration (`exp`)
  - Not-before (`nbf`)
  - Subject (`sub`)
  - Explicit algorithm allowlist
- Unsigned tokens (`alg=none`) or decode-only flows are rejected.
- Principal user identity is derived from verified `sub`.

## Identity endpoints

- `GET /v1/me`: authenticated principal summary and workspace memberships.
- `GET /v1/workspaces`: workspaces visible to authenticated principal.
- `GET /v1/workspaces/:workspaceId`: membership summary for one workspace.

Responses expose non-sensitive identity and membership data only.

## Route-to-role security matrix

Legend:
- `AUTH`: any authenticated workspace member (OWNER, ADMIN, MEMBER)
- `ADMIN+`: OWNER or ADMIN
- `PUBLIC`: no authentication required

| Route family | Methods | Required role | Cross-workspace behavior |
| --- | --- | --- | --- |
| Health/readiness | `GET /healthz`, `GET /readyz` | PUBLIC | n/a |
| Identity | `GET /v1/me`, `GET /v1/workspaces`, `GET /v1/workspaces/:workspaceId` | AUTH | Non-member workspace returns `404 WORKSPACE_ACCESS_DENIED` |
| Projects | `POST /v1/projects` | ADMIN+ | Non-member workspace returns `404 WORKSPACE_ACCESS_DENIED` |
| Projects | `GET /v1/projects/:id` | AUTH | Foreign workspace returns `404 PROJECT_NOT_FOUND` |
| Runs | `POST /v1/projects/:id/runs`, `GET /v1/runs/:runId`, `POST /v1/runs/:runId/actions` | AUTH | Foreign workspace returns `404 PROJECT_NOT_FOUND` / `404 RUN_NOT_FOUND` |
| SSE/events | `GET /v1/runs/:runId/events` | AUTH | Foreign workspace returns `404 RUN_NOT_FOUND` |
| Artifacts | `GET /v1/runs/:runId/artifacts` | AUTH | Foreign workspace returns `404 RUN_NOT_FOUND` |
| Project files | `GET /v1/projects/:id/files`, `GET /v1/projects/:id/files/content`, `PUT /v1/projects/:id/files/content` | AUTH | Foreign workspace returns `404 PROJECT_NOT_FOUND` / `404 PROJECT_FILE_NOT_FOUND` |
| Attachments | upload intent, complete, list, download under `/v1/projects/:id/attachments` | AUTH | Foreign workspace returns `404 PROJECT_NOT_FOUND` / `404 ATTACHMENT_NOT_FOUND` |
| Database lifecycle | provision, read status, latest migration artifact, destroy action under `/v1/projects/:id/databases` | ADMIN+ | Foreign workspace returns `404` not found variants |

## Authorization outcomes

- Known workspace but insufficient role:
  - `403 INSUFFICIENT_WORKSPACE_ROLE`
- Missing authentication header:
  - `401 AUTHENTICATION_REQUIRED`
- Invalid/expired/wrong-issuer/wrong-audience/bad-signature token:
  - `401 INVALID_ACCESS_TOKEN`
- Workspace exists but caller is not a member:
  - `404 WORKSPACE_ACCESS_DENIED`

## IDOR protection model

Repository queries enforce workspace boundaries using membership predicates.
Handlers do not trust incoming `workspaceId`, `projectId`, `runId`, `attachmentId`,
`databaseId`, or event stream IDs without membership-scoped lookups.

This preserves existing idempotency and compare-and-swap guarantees while
blocking cross-tenant object access.

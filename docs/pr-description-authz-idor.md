# PR Description: Control API AuthN/AuthZ + Tenant Isolation

## Summary

This change introduces production-grade authentication, workspace authorization,
and repository-level tenant isolation for the Fastify Control API.

## Security behaviors added

- OIDC/JWT signature verification through JWKS.
- Strict issuer/audience/exp/nbf/sub/algorithm checks.
- Request-scoped typed principal on Fastify requests.
- Auth required on every API endpoint except health/readiness.
- Workspace membership enforcement in route handlers and repository queries.
- Owner/Admin-only controls for workspace/project/database administrative actions.
- Non-enumerating cross-workspace access behavior (`404`).
- Structured role-denied behavior (`403 INSUFFICIENT_WORKSPACE_ROLE`).

## Tested IDOR scenarios

- Cross-workspace project read is denied (`GET /v1/projects/:id`).
- Cross-workspace run read is denied (`GET /v1/runs/:runId`).
- Cross-workspace SSE stream is denied (`GET /v1/runs/:runId/events`).
- Cross-workspace artifact listing is denied (`GET /v1/runs/:runId/artifacts`).
- Cross-workspace file listing/content access is denied.
- Cross-workspace attachment listing/download is denied.
- Cross-workspace database status access is denied.
- Cross-workspace workspace lookup is denied (`GET /v1/workspaces/:workspaceId`).

## Role policy tests

- OWNER can create projects and perform administrative database operations.
- ADMIN can create projects and perform administrative database operations.
- MEMBER cannot perform admin-only project/database operations.
- MEMBER can run project-scoped operational flows (runs, attachments, files).

## Authentication tests

- Missing `Authorization` header -> `AUTHENTICATION_REQUIRED`.
- Invalid token/signature -> `INVALID_ACCESS_TOKEN`.
- Wrong issuer -> `INVALID_ACCESS_TOKEN`.
- Wrong audience -> `INVALID_ACCESS_TOKEN`.
- Expired token -> `INVALID_ACCESS_TOKEN`.
- Unsigned token (`alg=none`) -> `INVALID_ACCESS_TOKEN`.

## Operational safety

- Existing Phase 2-4 idempotency/CAS behavior is preserved.
- Worker trust boundaries remain unchanged.
- No secrets, private keys, tenant IDs, or tokens are committed.

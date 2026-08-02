# Phase 2: E2B validation and preview lifecycle

## Durable sequence

1. BullMQ claims the run using status and `controlVersion` compare-and-swap.
2. LangGraph restores completed Mike, Emma, Bob, and Alex tasks from PostgreSQL.
3. The worker reads the latest immutable version of every generated project file.
4. `ProjectValidationRunner` rejects a snapshot without `package.json` or
   `pnpm-lock.yaml` before provisioning any compute.
5. E2B creates a secure sandbox with a 15-minute kill timeout, private ingress,
   and an explicit egress allowlist.
6. The worker restores the revision and executes the fixed command pipeline:
   locked install, Prisma validation, lint, typecheck, test, and production build.
7. Each command result is stored in `sandbox_commands` and streamed as an ordered
   `task.progress` event. Validation stops on the first non-zero exit.
8. The worker starts the built Next.js server in the background, verifies it on
   `127.0.0.1:3000`, and obtains E2B's private upstream target.
9. The provider traffic header is stored in Redis with the sandbox expiry. Only
   safe lifecycle metadata and the signed gateway URL are stored in PostgreSQL.
10. The preview gateway verifies the HMAC hostname, reads the target from Redis,
    injects provider authentication upstream, and proxies HTTP or WebSocket HMR.
11. The worker emits `preview.updated` and only then marks the run complete.

Queue redelivery does not repeat completed agent calls. A validation retry uses
the BullMQ attempt number as its idempotency key, and a stopped or failed
publication revokes the Redis target and terminates the sandbox.

## Security boundary

| Boundary | Enforcement |
| --- | --- |
| Sandbox egress | `allowedHosts` is explicit; an empty list denies all egress. |
| Sandbox ingress | E2B public traffic is disabled and a traffic token is required. |
| Browser URL | Unique session hostname, expiry, audience, and HMAC signature. |
| Provider credential | TTL-bound Redis only; excluded from PostgreSQL and SSE. |
| iframe embedding | CSP `frame-ancestors` contains only `PREVIEW_UI_ORIGIN`. |
| Browser capabilities | restrictive CSP, Permissions Policy, no referrer, no cache. |
| Execution lifetime | sandbox is killed after `SANDBOX_IDLE_TIMEOUT_MS` (15 minutes by default). |
| Cleanup | validation failure, cancellation, stale control version, or publication failure terminates E2B and deletes the Redis target. |

`E2B_ALLOWED_HOSTS` defaults to `registry.npmjs.org,binaries.prisma.sh`. Add a
destination only after an explicit product/security decision. The sandbox is
never given platform database, Redis, internal-service, or model-provider
credentials.

## Live verification boundary

The deterministic suite injects an E2B-compatible test double and verifies the
real SDK adapter options, command order, cleanup, signed proxy, provider-header
isolation, CSP, and WebSocket forwarding. A live provider smoke test additionally
requires `E2B_API_KEY`, an E2B template with Node.js and pnpm, and billable network
access. Absence of those credentials is reported as "not run", never as success.

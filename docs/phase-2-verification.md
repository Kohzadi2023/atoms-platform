# Phase 2 verification record

Date: 2026-08-01

## Deterministic gates

`pnpm run ci:verify` completed successfully from the repository root.

| Gate | Result |
| --- | --- |
| Frozen `pnpm-lock.yaml` install | Pass |
| Turborepo build | 9/9 packages pass |
| Unit/contract/component tests | 43 pass, 0 fail |
| Live E2B smoke | 1 skipped (explicit credential/billing opt-in absent) |
| TypeScript typecheck | 9/9 packages pass |
| Prisma 7 schema validation | Pass |
| Dependency audit at high severity | No known vulnerabilities |
| Local secret-pattern scan | 116 text files checked, pass |
| Phase 2 demo script syntax | Pass |

## Covered behavior

- Real E2B SDK creation, reconnection, private ingress, network allowlist,
  filesystem write, foreground command, background process, port exposure, and
  termination code paths.
- Fixed frozen install / Prisma / lint / typecheck / test / build command order.
- Fail-fast validation and sandbox cleanup on deterministic errors.
- Durable worker ordering: Alex commit -> Phase 2 validation -> preview publish
  -> run completion.
- Prisma lifecycle rows for sandbox sessions, command evidence, and previews.
- Versioned ordered SSE payloads without provider credentials.
- HMAC hostname verification, expiry, Redis TTL target storage, HTTP proxy,
  CSP/frame isolation, provider-header injection, and WebSocket HMR proxying.
- Revocation and E2B termination when run completion loses a cancellation or
  control-version race.

## Explicitly not claimed

- No billable live E2B sandbox was created because `E2B_API_KEY` and explicit
  `RUN_LIVE_E2B_TESTS=true` were not available together.
- No live OpenAI, PostgreSQL, or Redis service was available in the verification
  environment; their production adapters were compiled and tested through
  deterministic collaborators.
- Container images were not built because a Docker executable was unavailable.

Run the credential-gated provider smoke deliberately with:

```bash
RUN_LIVE_E2B_TESTS=true E2B_API_KEY=<secret> \
  pnpm --filter @atoms/sandbox-provider test
```

That smoke is intentionally outside the default CI gate because it provisions
billable external compute.

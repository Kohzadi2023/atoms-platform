# Ordered event catalogue

All events are persisted with a monotonically increasing per-run `sequence` and
delivered over SSE. Reconnect with `Last-Event-ID`; the Control API replays only
events whose sequence is greater than that value.

## Phase 2 payloads

### `sandbox.ready`

Schema: `SandboxReadyEventPayloadV1Schema`

```json
{
  "version": "v1",
  "sandboxSessionId": "00000000-0000-4000-8000-000000000001",
  "status": "VALIDATING"
}
```

### `task.progress`

Schema: `SandboxValidationProgressEventPayloadV1Schema`

The payload identifies a fixed validation step, its exit code, duration, and
bounded stdout/stderr. Current steps are `install`, `prisma-validate`, `lint`,
`typecheck`, `test`, `build`, `preview-start`, and `preview-health`.

### `preview.updated`

Schema: `PreviewUpdatedEventPayloadV1Schema`

```json
{
  "version": "v1",
  "previewSessionId": "00000000-0000-4000-8000-000000000001",
  "status": "READY",
  "url": "https://signed-host.preview.example.com/",
  "expiresAt": "2026-08-01T12:15:00.000Z"
}
```

The same schema reports `STOPPED`, `EXPIRED`, or `ERROR`; `url` is omitted once
the capability must no longer be used. A completion/cancellation race revokes
the Redis target, terminates E2B, persists `STOPPED`, and appends this event.

Provider upstream URLs, E2B traffic tokens, environment variables, and secret
references are forbidden from these payloads.

## Phase 3 payloads

### `integration.status_changed`

Schema: `DatabaseStatusChangedEventPayloadV1Schema`

```json
{
  "version": "v1",
  "integration": "generated-database",
  "databaseInstanceId": "00000000-0000-4000-8000-000000000010",
  "operationId": "00000000-0000-4000-8000-000000000011",
  "provider": "SUPABASE",
  "status": "MIGRATING",
  "message": "Applying forward-only migrations and idempotent seed data in E2B"
}
```

The ordered status progression is `QUEUED -> PROVISIONING -> HEALTH_CHECK ->
MIGRATING -> READY`. Failures use `FAILED`; confirmed teardown uses `DELETING ->
DELETED`. The payload never contains a provider token, database password,
connection URL, Vault path value, or E2B environment variable.

Reconciliation reuses this payload without changing its version. Recovery
dispatch, recovery exhaustion, and confirmed provider-resource loss are
communicated through the existing `status` and bounded `message` fields. The
internal fencing version and orphan-finding identifiers remain private
control-plane data.

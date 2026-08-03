# Web workspace vertical slice

The `apps/web` workspace is the first real browser surface for the durable
Control API. It is a Next.js, React, TypeScript, Tailwind CSS, and Monaco
application; it does not introduce a second frontend stack.

## Implemented flow

1. Create a project in an existing tenant workspace.
2. Optionally upload up to five PDF, text, PNG, JPEG, or WebP references through
   encrypted quarantine storage and wait for MIME and malware validation.
3. Create a durable run from a prompt and immutable clean-attachment snapshots.
4. Stream ordered events with an explicit `Last-Event-ID` cursor and reconnect
   after a bounded server stream closes. A refresh stores only the project/run
   UUIDs, restores current CAS state from the API, and replays events from zero;
   prompts and generated code are never copied into browser storage.
5. Render Mike, Emma, Bob, Alex, and David task state, plan approval, run
   controls, deterministic validation evidence, and generated-database state.
6. Embed only a URL on the configured signed preview domain in a sandboxed,
   no-referrer iframe.
7. List the latest immutable project files, open them in Monaco, and save a
   manual edit with the latest observed version. A `409` conflict leaves the
   unsaved editor value intact.
8. Compare the latest file revision with its immediate predecessor.

The responsive layout displays both panes at 1280 px and uses an Agent Hub /
Project Workspace switch below 1024 px. Tabs, form controls, status updates,
focus rings, reduced-motion behavior, and the preview iframe have explicit
accessible names or live announcements.

## Control-plane additions

- `GET /v1/runs/{runId}` restores current status and `controlVersion` before a
  pause, resume, approval, cancellation, or retry.
- `POST /v1/runs/{runId}/actions` requires `approvalScope` when
  `action=approve` and rejects `approvalScope` on non-approve actions.
- `GET /v1/projects/{projectId}/files` returns only the latest summary for each
  path; file content remains opt-in through the existing content endpoint.
- `CONTROL_API_CORS_ORIGINS` is a comma-separated allowlist of exact browser
  origins. With no configured origin the Fastify API remains browser-closed.
- Every generated-database event includes its monotonic `operationVersion`, so
  the browser ignores stale reconciliation updates.

## Local start

```bash
cp .env.example .env
docker compose up -d
pnpm install --frozen-lockfile
pnpm db:migrate:deploy
pnpm db:seed:local
pnpm --filter @atoms/control-api dev
pnpm --filter @atoms/orchestrator-worker dev
pnpm --filter @atoms/preview-gateway dev
pnpm --filter @atoms/web dev
```

The deterministic seed creates workspace
`00000000-0000-4000-8000-000000000001`, which is also the non-secret default
in the web form.

## Attachment boundary

The composer and server share the same five-file / 10 MiB limits. Submission
does not create a run until every selected file reaches `CLEAN`; rejection,
scanner failure, timeout, or metadata mismatch is shown as an error. See
`docs/secure-attachments.md` for the storage, scan, snapshot, and model-input
invariants.

GitHub/Vercel deployment, public usage-cost aggregation, and destructive
database actions remain unavailable in this UI. Their tabs explain the missing
capability and expose no unsafe placeholder action.

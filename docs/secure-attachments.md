# Secure attachment vertical slice

The project composer supports PDF, UTF-8 text, PNG, JPEG, and WebP references
through an S3-compatible quarantine boundary. The limit is fixed in the shared
contract at five files per project and 10 MiB per file.

## Lifecycle

1. The Control API persists an `AWAITING_UPLOAD` record and returns a 15-minute
   signed `PUT` request. The object key is derived server-side as
   `tenants/{workspaceId}/projects/{projectId}/attachments/{attachmentId}/quarantine/source`;
   raw keys and provider credentials never cross the browser boundary.
2. The browser uploads directly with the exact declared content type and
   server-side-encryption headers, then calls the completion endpoint.
3. Completion verifies object existence, exact byte count, content type, and an
   optional normalized ETag before atomically moving the record to
   `QUARANTINED` and enqueueing a version-fenced BullMQ job.
4. The private worker claims `QUARANTINED -> SCANNING`, reads no more than the
   declared byte count, detects the MIME from bytes, calculates SHA-256, and
   streams the bytes through ClamAV's `INSTREAM` protocol.
5. A clean object is copied to an immutable hash-addressed clean key with
   server-side encryption. The database transition to `CLEAN` records the
   detected MIME, hash, scanner metadata, and timestamp. Quarantine deletion is
   best-effort after that durable transition.
6. MIME mismatches, malformed binary files, and malware are `REJECTED` and
   deleted from quarantine. Transient storage/scanner failures are retried by
   BullMQ; the final attempt becomes `FAILED`.
7. Run creation accepts only requested IDs that belong to the same project and
   are `CLEAN`. It copies filename, detected MIME, size, SHA-256, and clean
   object key into `agent_run_attachments`, making the run input immutable.
8. The worker reloads and re-hashes each snapshot. References are sent once to
   Emma; downstream agents consume Emma's structured PRD instead of rebilling
   the same file input for every agent.

The OpenAI adapter maps PDFs and text to Responses API `input_file` items and
images to `input_image` data URLs while retaining `store: false`. The platform's
five-by-10-MiB ceiling is also a hard 50-MiB combined ceiling. See the official
[OpenAI file-input guide](https://developers.openai.com/api/docs/guides/file-inputs)
and [image-input guide](https://developers.openai.com/api/docs/guides/images-vision).

## HTTP contract

- `POST /v1/projects/{projectId}/attachments/upload-intents`
- `POST /v1/projects/{projectId}/attachments/{attachmentId}/complete`
- `GET /v1/projects/{projectId}/attachments`
- `GET /v1/projects/{projectId}/attachments/{attachmentId}/download`
- `POST /v1/projects/{projectId}/runs` with `attachmentIds`

Download URLs are issued only for `CLEAN` records and expire after five
minutes. The versioned shapes live in `@atoms/contracts`; the rendered API
description is `docs/attachments-openapi.yaml`.

In staging, the storage adapter has two endpoints with intentionally different
trust boundaries. `S3_ENDPOINT=http://minio:9000` is private and handles every
server-side head/get/copy/delete operation. `S3_PUBLIC_ENDPOINT` is the exact
HTTPS storage origin used only to calculate presigned browser PUT/GET URLs.
Caddy routes only the configured bucket path to MinIO and does not retain access
logs containing signed query capabilities.

## Local development

`docker compose up -d` starts PostgreSQL, Redis, a pinned MinIO server, a
one-shot bucket/CORS initializer, and a pinned ClamAV daemon. MinIO uses a
static test-only KMS key so the same SSE-S3 headers required in production work
locally. `MINIO_API_CORS_ALLOW_ORIGIN` must match the exact local web origin.

Production deployments must use private service networking, scoped workload
credentials, a managed KMS key, exact browser CORS origins, audit logging, and a
bucket lifecycle rule that expires abandoned quarantine objects. ClamAV must
have no public ingress. The Control API and worker receive storage credentials
only through their private runtime environments.

## Deterministic integration gate

CI starts the pinned MinIO and ClamAV containers and proves the real signed
PUT/CORS/encryption, quarantine read, MIME/hash inspection, clean and EICAR scan,
hash-addressed copy/delete, and signed GET lifecycle. The test is fail-closed and
requires the exact `DEDICATED_EPHEMERAL_STORAGE` confirmation value.

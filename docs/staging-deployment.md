# Single-host staging deployment

This is the first, provider-neutral deployment slice for Issue #22. It prepares
the existing web, Control API, worker, preview gateway, PostgreSQL, Redis,
MinIO, and ClamAV services for one Linux host with Docker Compose. The same
manifest can run on an Azure VM or another approved Docker host.

This slice does **not** publish a URL, configure DNS/TLS, create cloud
resources, or waive the live-provider gate in Issue #14. Before an actual
rollout, record the selected host and domains and either complete Issue #14 or
record the explicit exception required by Issue #22.

## Security boundary

`deploy/staging/staging.env.example` contains only public deployment metadata.
The real public env file may contain domains, ports, a full Git SHA, the
Supabase URL, and its browser-safe publishable key. The preflight rejects every
variable outside that allowlist.

Runtime credentials live in an absolute directory outside the repository. The
directory must grant no group or other access, and every file must be a regular
file with no group or other permission bits. Symlinks are rejected. Compose
mounts the four service env files as file-backed secrets, and Node 24 loads each
file at process start. Their values therefore do not appear in image layers,
build arguments, or Docker's configured container environment.

The manifest publishes only these loopback listeners for a future TLS reverse
proxy:

| Listener | Container | Purpose |
|---|---:|---|
| `127.0.0.1:ATOMS_WEB_PORT` | 3000 | Agent Hub |
| `127.0.0.1:ATOMS_CONTROL_API_PORT` | 3001 | Control API |
| `127.0.0.1:ATOMS_PREVIEW_GATEWAY_PORT` | 3002 | Wildcard preview gateway |

PostgreSQL, Redis, MinIO, the MinIO console, and ClamAV have no host-published
ports. Infrastructure services use an internal Docker network. Application
services get a second network for required outbound provider traffic.

## Public environment

Install a copy of the example outside the checkout and replace every example
value. `ATOMS_IMAGE_TAG` must be the complete lowercase 40-character SHA that
was verified by CI. The web, API, and preview names must be real DNS names, and
all public/auth endpoints must use HTTPS.

```bash
sudo install -d -m 0755 /etc/atoms/staging
sudo install -m 0644 deploy/staging/staging.env.example /etc/atoms/staging/staging.env
sudo install -d -m 0700 /etc/atoms/staging/secrets
```

Do not put a password, token, private key, signing secret, service-role key, or
development access token in `staging.env`.

## Secret-file contract

Populate the following files through the host's approved secret-delivery
mechanism. Do not place credential values in shell arguments, terminal output,
source control, image build arguments, or tickets.

Opaque single-line files:

| File | Contract |
|---|---|
| `postgres-password` | Unique PostgreSQL password, at least 24 characters |
| `redis-password` | Unique Redis password, at least 24 characters |
| `minio-root-user` | MinIO bootstrap identity; not used by the apps |
| `minio-root-password` | Unique MinIO root password, at least 24 characters |
| `s3-access-key-id` | Dedicated application identity; different from root |
| `s3-secret-access-key` | Dedicated application secret, at least 24 characters |
| `minio-kms-secret-key` | `<key-id>:<base64-encoded 32-byte key>` |

Service env files use unquoted `NAME=value` lines. Values cannot contain
whitespace or `#`; generate URL-safe credentials, and percent-encode passwords
inside PostgreSQL and Redis URLs. The duplicate copies are intentional: the
preflight compares them without printing values while keeping each container's
credential scope small.

`migration.env`:

```text
DATABASE_URL=postgresql://<user>:<encoded-password>@postgres:5432/<database>?schema=public
```

`control-api.env`:

```text
DATABASE_URL=postgresql://<user>:<encoded-password>@postgres:5432/<database>?schema=public
REDIS_URL=redis://:<encoded-password>@redis:6379
S3_ACCESS_KEY_ID=<application-access-key-id>
S3_SECRET_ACCESS_KEY=<application-secret-access-key>
S3_KMS_KEY_ID=<key-id-from-minio-kms-secret-key>
```

`worker.env`:

```text
DATABASE_URL=postgresql://<user>:<encoded-password>@postgres:5432/<database>?schema=public
REDIS_URL=redis://:<encoded-password>@redis:6379
OPENAI_API_KEY=<credential>
E2B_API_KEY=<credential>
PREVIEW_SIGNING_SECRET=<at-least-32-random-characters>
S3_ACCESS_KEY_ID=<application-access-key-id>
S3_SECRET_ACCESS_KEY=<application-secret-access-key>
S3_KMS_KEY_ID=<key-id-from-minio-kms-secret-key>
SUPABASE_ACCESS_TOKEN=<credential>
SUPABASE_ORGANIZATION_SLUG=<organization-slug>
VAULT_ADDR=https://<vault-endpoint>
VAULT_TOKEN=<credential>
```

`VAULT_KV_MOUNT` and `VAULT_NAMESPACE` are the only optional `worker.env`
variables. `preview-gateway.env` contains only:

```text
REDIS_URL=redis://:<encoded-password>@redis:6379
PREVIEW_SIGNING_SECRET=<same-worker-signing-secret>
```

Set the directory and files to owner-only access after delivery:

```bash
sudo chmod 0700 /etc/atoms/staging/secrets
sudo chmod 0600 /etc/atoms/staging/secrets/*
```

## Fail-closed validation

Run the repository preflight before any image build or service mutation. It
reports variable/file names only; it never includes configured values in its
result.

```bash
pnpm staging:deploy:preflight -- \
  --env-file /etc/atoms/staging/staging.env \
  --secrets-dir /etc/atoms/staging/secrets

docker compose \
  --env-file /etc/atoms/staging/staging.env \
  -f deploy/staging/compose.yaml \
  config --quiet
```

The preflight verifies:

- the full deployed Git SHA, distinct HTTPS endpoints, real DNS names, and
  asymmetric JWT algorithms;
- a public-env allowlist that excludes all runtime credentials and development
  auth switches;
- directory/file type and permission rules;
- identical internal PostgreSQL and Redis URLs across the minimum required
  services;
- agreement between infrastructure passwords, URLs, S3 credentials, preview
  signing secrets, and the MinIO KMS key ID;
- complete worker-only OpenAI, E2B, Supabase, and Vault credentials.

## Controlled rollout

After the Issue #22 gates are recorded, build from the exact checked-out SHA.
No runtime secret is available during image compilation; only browser-public
configuration is passed to the web build.

```bash
docker compose \
  --env-file /etc/atoms/staging/staging.env \
  -f deploy/staging/compose.yaml \
  build --pull

docker compose \
  --env-file /etc/atoms/staging/staging.env \
  -f deploy/staging/compose.yaml \
  up -d --wait

docker compose \
  --env-file /etc/atoms/staging/staging.env \
  -f deploy/staging/compose.yaml \
  ps
```

The one-shot `migrate` service runs `prisma migrate deploy`. Control API and
worker startup is blocked until migration succeeds. MinIO initialization
creates the attachment bucket and attaches a bucket-scoped object policy only
to the dedicated application identity. The worker cannot enable
approval-gated orphan deletion; the manifest hard-codes that switch to
`false`.

Do not run `docker compose down --volumes` during normal operations. Named
volumes hold PostgreSQL, Redis append-only data, MinIO objects, ClamAV data, and
the web cache.

## Evidence and rollback boundary

Every application container is labeled with the full deployed revision. Keep
the immediately previous images on the host. An application rollback changes
`ATOMS_IMAGE_TAG` to that already-built revision and runs `up -d --no-build`.
Database migrations remain forward-only; a rollback is valid only after the
previous application version has been verified against the migrated schema.

DNS/TLS routing, authenticated smoke tests, restart durability, backup/restore,
and a rehearsed rollback are later Issue #22 slices. This manifest alone is not
evidence that those acceptance criteria passed.

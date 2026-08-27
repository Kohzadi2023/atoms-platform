# Single-host staging deployment

This provider-neutral deployment contract for Issue #22 prepares the existing
web, Control API, worker, preview gateway, PostgreSQL, Redis, MinIO, and ClamAV
services for one Linux host with Docker Compose. Caddy terminates externally
issued TLS, redirects HTTP to HTTPS, and routes the two exact application names
plus wildcard preview names. The same manifest can run on an Azure VM or
another approved Docker host.

This contract does **not** create a host, change DNS, issue a certificate,
publish a URL, or waive the live-provider gate in Issue #14. Before an actual
rollout, record the selected host and domains and either complete Issue #14 or
record the explicit exception required by Issue #22.

## Security boundary

`deploy/staging/staging.env.example` contains only public deployment metadata.
The real public env file may contain domains, a full Git SHA, the Supabase URL,
and its browser-safe publishable key. The preflight rejects every variable
outside that allowlist.

Runtime credentials live in an absolute directory outside the repository. The
directory must be exactly `0700`, every mounted file must be immutable mode
`0444`, and symlinks are rejected. The apparently broad file read bits are
contained by the owner-only directory on the host; they are required because
Compose preserves host ownership for file-backed secrets while the images run
with different non-root users. Compose mounts only the files granted to each
service, and Node 24 loads each service env at process start. Their values
therefore do not appear in image layers, build arguments, or Docker's configured
container environment.

The manifest publishes only TCP 80, TCP 443, and UDP 443 from the Caddy ingress.
Web, Control API, and preview gateway ports exist only on an internal ingress
network. PostgreSQL, Redis, MinIO, the MinIO console, and ClamAV also have no
host-published ports. Application services use a separate network for required
outbound provider traffic.

| Public name | Internal target | Contract |
|---|---|---|
| `ATOMS_WEB_ORIGIN` | `web:3000` | Exact Agent Hub HTTPS origin |
| `ATOMS_CONTROL_API_ORIGIN` | `control-api:3001` | Exact Control API HTTPS origin |
| `*.ATOMS_PREVIEW_BASE_DOMAIN` | `preview-gateway:3002` | Signed preview HTTP and WebSocket traffic |

Caddy preserves the incoming host boundary used by preview-ticket validation
and supports SSE and WebSocket proxying. It emits JSON access logs for the
exact web/API names, while wildcard preview access logging is intentionally
disabled so signed preview hostnames are not retained. Its admin API is
disabled, and its health endpoint is reachable only inside its own container.

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

TLS files:

| File | Contract |
|---|---|
| `tls-certificate.pem` | PEM leaf certificate first, followed by any intermediate chain |
| `tls-private-key.pem` | Matching, unencrypted PEM private key |

The leaf certificate must already be valid, remain valid for at least seven
days, cover the exact web and API hostnames, and include a wildcard SAN for
`*.ATOMS_PREVIEW_BASE_DOMAIN`. Certificate issuance and renewal stay with the
approved DNS/TLS provider; this repository does not accept a DNS provider token
or run an ACME DNS challenge.

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

Keep the directory owner-only and make every mounted file read-only after
delivery. Do not loosen the directory mode: it is the host-side confidentiality
boundary for the `0444` files.

```bash
sudo chmod 0700 /etc/atoms/staging/secrets
sudo chmod 0444 /etc/atoms/staging/secrets/*
```

## Fail-closed validation

Run the repository preflight before any image build or service mutation. It
reports variable/file names only; it never includes configured values in its
result. The repository validation command also asks Docker Compose to render
the manifest and runs `caddy validate` in an isolated, disposable Compose
project.

```bash
pnpm staging:deploy:preflight -- \
  --env-file /etc/atoms/staging/staging.env \
  --secrets-dir /etc/atoms/staging/secrets

pnpm staging:deploy:compose:validate -- \
  --env-file /etc/atoms/staging/staging.env \
  --secrets-dir /etc/atoms/staging/secrets
```

The preflight verifies:

- the full deployed Git SHA, distinct HTTPS endpoints, real DNS names, and
  asymmetric JWT algorithms;
- a public-env allowlist that excludes all runtime credentials and development
  auth switches;
- directory/file type and permission rules;
- TLS validity, certificate/private-key agreement, exact web/API SAN coverage,
  and wildcard preview SAN coverage;
- identical internal PostgreSQL and Redis URLs across the minimum required
  services;
- agreement between infrastructure passwords, URLs, S3 credentials, preview
  signing secrets, and the MinIO KMS key ID;
- complete worker-only OpenAI, E2B, Supabase, and Vault credentials.

## Persistent service bootstrap

PostgreSQL, Redis, and MinIO use explicitly named external Docker volumes. The
bootstrap creates a missing volume with ownership labels, or reuses it only
when every ownership label matches the selected Compose project, staging
environment, and data role. This prevents an existing unrelated volume from
being silently adopted. Their explicit names preserve the names generated by
the earlier Compose-managed manifest, so pre-existing unlabeled data causes a
fail-closed ownership error instead of selecting a new empty volume. Because
these three volumes are external, a Compose project teardown does not delete
them; removal requires a separate explicit Docker volume operation.

Run the bootstrap from a clean checkout whose `HEAD` exactly equals
`ATOMS_IMAGE_TAG`. It requires a normalized change-ticket identifier, a
single-purpose confirmation, and a new absolute evidence path outside both the
repository and secrets directory. Existing evidence is never overwritten.

```bash
pnpm staging:deploy:persistence:bootstrap -- \
  --env-file /etc/atoms/staging/staging.env \
  --secrets-dir /etc/atoms/staging/secrets \
  --change-ticket GH-22 \
  --evidence-out /var/lib/atoms/staging/evidence/persistence-bootstrap.json \
  --confirmation BOOTSTRAP_ATOMS_STAGING_PERSISTENCE
```

The command performs the secret-safe preflight before contacting Docker, checks
the clean revision pin, validates the rendered manifest, pulls the pinned
infrastructure images, and builds the migration image. It then creates or
verifies the three external data volumes, starts PostgreSQL, Redis, MinIO, and
ClamAV, initializes the private attachment bucket, verifies it with the
dedicated application identity, runs `prisma migrate deploy`, and requires
`prisma migrate status` plus all four service checks to succeed.

On failure, it emits no passing evidence and does not start the API, worker,
web, preview gateway, or ingress. It deliberately does not tear down persistent
services or remove volumes, because automatic cleanup after a partial migration
could destroy the state needed for diagnosis. The JSON evidence contains only
the change ticket, revision, migration names, logical service/volume names,
created-versus-reused state, and passed gate names.

## Controlled rollout

After the Issue #22 gates are recorded, the DNS `A`/`AAAA` records for the web,
API, and wildcard preview names must resolve to the selected host, and the host
firewall must admit TCP 80/443 and UDP 443 as intended. Build from the exact
checked-out SHA. No runtime secret is available during image compilation; only
browser-public configuration is passed to the web build.

First complete the persistent-service bootstrap above. Then build the remaining
revision-pinned application images and start the complete project:

```bash
docker compose \
  --env-file /etc/atoms/staging/staging.env \
  -f deploy/staging/compose.yaml \
  build --pull control-api orchestrator-worker preview-gateway web

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
creates the attachment bucket and idempotently attaches a bucket-scoped object
policy only to the dedicated application identity. The worker cannot enable
approval-gated orphan deletion; the manifest hard-codes that switch to
`false`.

Do not run `docker compose down --volumes` during normal operations. The
external PostgreSQL, Redis, and MinIO volumes survive that command, but ClamAV
data, the web cache, and Caddy state remain Compose-managed. Never delete any
external staging data volume as part of an application rollback.

For certificate renewal, install the replacement pair atomically, rerun both
preflight commands, and recreate only `reverse-proxy`. Never restart ingress
with an unvalidated or mismatched pair.

## Evidence and rollback boundary

Every application container is labeled with the full deployed revision. Keep
the immediately previous images on the host. An application rollback changes
`ATOMS_IMAGE_TAG` to that already-built revision and runs `up -d --no-build`.
Database migrations remain forward-only; a rollback is valid only after the
previous application version has been verified against the migrated schema.

The bootstrap evidence proves only local host preflight, volume ownership,
dependency health, bucket initialization, and migration status. Actual DNS
ownership, externally reachable TLS, authenticated smoke tests, restart
durability, backup/restore, and a rehearsed rollback still require live
evidence. This configuration alone is not evidence that those acceptance
criteria passed.

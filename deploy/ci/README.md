# Disposable attachment storage CI

The attachment job failed in CI run 163 before any integration assertion:
Docker could not pull `minio/minio:RELEASE.2025-09-07T16-13-09Z` and reported
`pull access denied`. ClamAV's parallel pull was interrupted. The repository's
verification and migration jobs passed.

MinIO's [official Community README](https://github.com/minio/minio/blob/master/README.md)
now describes a source-only distribution and an unmaintained Community project.
The CI-only overlay builds unmodified official sources instead of relying on
the unavailable MinIO Docker Hub images. It does not introduce a mirror,
registry credentials, an AIStor license, or a different storage provider.

| Component | Existing fixture release | Required source commit |
| --- | --- | --- |
| MinIO server | `RELEASE.2025-09-07T16-13-09Z` | `07c3a429bfed433e49018cb0f78a52145d4bedeb` |
| MinIO client | `RELEASE.2025-08-13T08-35-41Z` | `7394ce0dd2a80935aded936b09fa12cbb3cb8096` |

Each release tag must match its expected immutable commit **before** compilation.
Both builds use Go `1.27.1`, `CGO_ENABLED=0`, `GOTOOLCHAIN=local`, and
`go build -mod=readonly -trimpath`; upstream module checksums remain enforced.
These are builds of the pinned release sources, not bit-for-bit reproductions
of historical vendor binaries. Both runtime images retain upstream licenses
and trusted CA certificates; the client image supports the initializer's shell.

## Isolation and unchanged acceptance criteria

Only the `attachment-storage-integration` job selects:

```yaml
COMPOSE_FILE: compose.yaml:deploy/ci/compose.storage.yaml
COMPOSE_PROJECT_NAME: atoms-ci-storage
```

Compose resolves the overlay's build paths relative to the **first**, root
Compose file. The build context is only `deploy/ci`, not application files or
host credentials. Explicitly build `minio` and `minio-init` before startup; their
`pull_policy: never` forbids falling back to an unpublished `atoms-ci/*` image
in a registry. Images are local to the disposable runner and never pushed.

The overlay changes only those two services' image/build selection. The root
Compose configuration retains fixture credentials, commands, KMS encryption,
CORS, ClamAV and volumes. Readiness remains bounded and the signed
quarantine-to-clean lifecycle test still requires `DEDICATED_EPHEMERAL_STORAGE`.
Uploads, KMS use, CORS, clean/EICAR malware scanning, copy/delete and signed
download assertions are not skipped or replaced with mocks.

The job reports logs on failure and always removes its isolated disposable
Compose services/volumes. It has no Azure deployment, public domain/TLS change,
live secret access, provider call, registry login, or image publication.

`compose.yaml`, `deploy/staging/compose.yaml` and the production recovery image
references are intentionally unchanged. This fixes **CI acquisition only**;
before using those production paths, image distribution/support requires a
separately approved plan. No working staging service is migrated by this change.

## Verification

```sh
pnpm test:ci-changes
```

On a disposable Docker-equipped machine, validate the real merge/build/start
using the two Compose files and an explicitly isolated project name. Do not run
volume-removing cleanup against an existing local or staging project.

The GitHub CI job is the Docker runtime verification environment. A local
source compilation or a passing workflow-contract test alone does not prove
that the full MinIO/ClamAV integration passed.

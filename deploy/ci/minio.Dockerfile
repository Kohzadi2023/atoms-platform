# CI-only, unmodified Community sources. No registry credentials, third-party
# mirrors, AIStor license, image publication, or production-image replacement.
# Release tags are checked against immutable commits before compilation.
FROM golang:1.27.1 AS go-base
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src

FROM go-base AS minio-build
RUN git clone --depth 1 --branch RELEASE.2025-09-07T16-13-09Z https://github.com/minio/minio.git . \
    && test "$(git rev-parse HEAD)" = "07c3a429bfed433e49018cb0f78a52145d4bedeb"
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -mod=readonly -trimpath -o /out/minio .

FROM go-base AS mc-build
RUN git clone --depth 1 --branch RELEASE.2025-08-13T08-35-41Z https://github.com/minio/mc.git . \
    && test "$(git rev-parse HEAD)" = "7394ce0dd2a80935aded936b09fa12cbb3cb8096"
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -mod=readonly -trimpath -o /out/mc .

FROM busybox:1.37.0 AS runtime
COPY --from=go-base /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN mkdir -p /data /root /tmp && chmod 1777 /tmp

FROM runtime AS minio
COPY --from=minio-build /out/minio /usr/local/bin/minio
COPY --from=minio-build /src/LICENSE /licenses/MINIO-AGPL.txt
ENTRYPOINT ["/usr/local/bin/minio"]

FROM runtime AS mc
COPY --from=mc-build /out/mc /usr/local/bin/mc
COPY --from=mc-build /src/LICENSE /licenses/MC-AGPL.txt
ENTRYPOINT ["/usr/local/bin/mc"]

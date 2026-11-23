# syntax=docker/dockerfile:1

# Rebuild the official privilege-switching helper with patched Go dependencies.
FROM golang:1.27.4-alpine3.24@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS gosu-build
ADD --checksum=sha256:207a2045e890d3ca3326027c5f585733085960b401a49dbc00e3bb628c054cf8 https://codeload.github.com/tianon/gosu/tar.gz/refs/tags/1.20 /tmp/gosu.tar.gz
WORKDIR /src/gosu
RUN tar -xzf /tmp/gosu.tar.gz --strip-components=1 -C /src/gosu \
    && go get golang.org/x/sys@v0.44.0 \
    && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w -X main.Version=1.20' -o /out/gosu .

# Alpine 3.23 main remains supported through November 2027.
FROM postgres:17.12-alpine3.23@sha256:45e1cc85c2b483a3dbd3438821ab41e32c0386564ef3c273261e8d274bb8b31e AS postgres-runtime
RUN apk upgrade --no-cache
COPY --from=gosu-build /out/gosu /usr/local/bin/gosu
RUN gosu nobody true && test "$(gosu postgres id -un)" = postgres

# Ship only the patched filesystem, without superseded binaries in lower layers.
# Keep the package database so scanners can inspect every installed component.
FROM scratch
COPY --from=postgres-runtime / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    GOSU_VERSION=1.20 \
    LANG=en_US.utf8 \
    PG_MAJOR=17 \
    PG_VERSION=17.12 \
    PGDATA=/var/lib/postgresql/data
VOLUME /var/lib/postgresql/data
EXPOSE 5432
STOPSIGNAL SIGINT
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["postgres"]

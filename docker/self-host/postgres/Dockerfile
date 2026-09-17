FROM rust:bookworm AS durable-builder
ARG TARGETARCH
RUN set -eux; mkdir -p /out; \
    if [ "$TARGETARCH" = arm64 ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends ca-certificates curl gnupg git pkg-config libssl-dev libclang-dev clang; \
      curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | gpg --batch --yes --dearmor -o /usr/share/keyrings/postgresql.gpg; \
      echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends postgresql-18 postgresql-server-dev-18; \
      cargo install --locked cargo-pgrx --version 0.16.1; \
      git init /src; \
      git -C /src fetch --depth 1 https://github.com/microsoft/pg_durable.git 5bbbe46216f9cf1a20a4a14fd16eb9a5b8723656; \
      git -C /src checkout --detach FETCH_HEAD; \
      test "$(git -C /src rev-parse HEAD)" = 5bbbe46216f9cf1a20a4a14fd16eb9a5b8723656; \
      make -C /src package PG_CONFIG=/usr/lib/postgresql/18/bin/pg_config; \
      make -C /src install PG_CONFIG=/usr/lib/postgresql/18/bin/pg_config DESTDIR=/out; \
    fi

FROM postgres:18-bookworm
ARG TARGETARCH

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates gnupg lsb-release; \
    install -d /etc/apt/keyrings; \
    curl -fsSL https://repo.pigsty.io/key \
      | gpg --batch --yes --dearmor -o /etc/apt/keyrings/pigsty.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/pigsty.gpg] https://repo.pigsty.io/apt/pgsql/$(. /etc/os-release && echo $VERSION_CODENAME) $(. /etc/os-release && echo $VERSION_CODENAME) main" \
      > /etc/apt/sources.list.d/pigsty-pgsql.list; \
    curl -fsSL https://documentdb.io/documentdb-archive-keyring.gpg \
      | gpg --batch --yes --dearmor -o /usr/share/keyrings/documentdb-archive-keyring.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/documentdb-archive-keyring.gpg] https://documentdb.io/deb stable deb12" \
      > /etc/apt/sources.list.d/documentdb.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      postgresql-18-cron \
      postgresql-18-documentdb \
      postgresql-18-http \
      postgresql-18-pgaudit \
      postgresql-18-pg-jsonschema \
      postgresql-18-pg-net \
      postgresql-18-pgvector \
      postgresql-18-postgis-3 \
      postgresql-18-pgsodium \
      postgresql-18-hypopg \
      postgresql-18-index-advisor \
      postgresql-18-pg-stat-kcache \
      postgresql-18-pg-plan-filter \
      postgresql-18-pgmq \
      postgresql-18-plpgsql-check \
      postgresql-18-pgtap \
      postgresql-18-supautils \
      postgresql-18-vault \
      postgresql-18-wal2json \
      postgresql-18-wrappers; \
    rm -rf /var/lib/apt/lists/*

COPY --from=durable-builder /out/ /

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) graphql_sha=271063ea2b8f99e00458473aa3b0e6dc0f88d341b2269401dc0b55a77b23970d ;; \
      arm64) graphql_sha=3c6c3e0b65a267dc2f26e5048dbf5af288ff8b0c5546c23ec2d74407c818c2ed ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 --max-time 180 \
      "https://github.com/supabase/pg_graphql/releases/download/v1.6.2/pg_graphql-v1.6.2-pg18-${TARGETARCH}-linux-gnu.deb" \
      -o /tmp/pg_graphql.deb; \
    echo "$graphql_sha  /tmp/pg_graphql.deb" | sha256sum -c -; \
    apt-get update; \
    apt-get install -y --no-install-recommends /tmp/pg_graphql.deb; \
    if [ "$TARGETARCH" = amd64 ]; then \
      curl -fsSL --retry 3 --max-time 180 \
        https://github.com/microsoft/pg_durable/releases/download/v0.2.8/pg-durable-postgresql-18_0.2.8-1_amd64.deb \
        -o /tmp/pg_durable.deb; \
      echo '090028f59b003613b150e61ccd5cdbebe70e69e65361913ad29b1f0b6af9e2bb  /tmp/pg_durable.deb' | sha256sum -c -; \
      apt-get install -y --no-install-recommends /tmp/pg_durable.deb; \
    fi; \
    rm -rf /var/lib/apt/lists/* /tmp/pg_durable.deb /tmp/pg_graphql.deb

COPY verify-extensions.sh /usr/local/bin/verify-postgres-extensions
RUN gosu postgres bash /usr/local/bin/verify-postgres-extensions

COPY initdb /docker-entrypoint-initdb.d
COPY pgsodium_getkey /usr/share/postgresql/18/extension/pgsodium_getkey
COPY vault_getkey /usr/share/postgresql/18/extension/vault_getkey
RUN chmod 0755 \
    /usr/share/postgresql/18/extension/pgsodium_getkey \
    /usr/share/postgresql/18/extension/vault_getkey

FROM postgres:18-bookworm

ARG PGDG_APT_REPOSITORY=https://apt.postgresql.org/pub/repos/apt

RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/pgdg.list ]; then \
      mv /etc/apt/sources.list.d/pgdg.list /etc/apt/sources.list.d/pgdg.list.disabled; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates gnupg lsb-release; \
    if [ -f /etc/apt/sources.list.d/pgdg.list.disabled ]; then \
      sed -i -E "s#https?://apt\\.postgresql\\.org/pub/repos/apt#${PGDG_APT_REPOSITORY}#" /etc/apt/sources.list.d/pgdg.list.disabled; \
      mv /etc/apt/sources.list.d/pgdg.list.disabled /etc/apt/sources.list.d/pgdg.list; \
    fi; \
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

ARG ENABLE_PG_DURABLE=false
ARG PG_GRAPHQL_VERSION=1.6.2
ARG PG_GRAPHQL_SHA256=271063ea2b8f99e00458473aa3b0e6dc0f88d341b2269401dc0b55a77b23970d
ARG PG_GRAPHQL_DOWNLOAD_URL=https://github.com/supabase/pg_graphql/releases/download/v1.6.2/pg_graphql-v1.6.2-pg18-amd64-linux-gnu.deb
ARG PG_DURABLE_SHA256=090028f59b003613b150e61ccd5cdbebe70e69e65361913ad29b1f0b6af9e2bb
ARG PG_DURABLE_DOWNLOAD_URL=https://github.com/microsoft/pg_durable/releases/download/v0.2.8/pg-durable-postgresql-18_0.2.8-1_amd64.deb

RUN set -eux; \
    curl --http1.1 -fsSL --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 15 --max-time 300 \
      "${PG_GRAPHQL_DOWNLOAD_URL}" \
      -o /tmp/pg_graphql.deb; \
    echo "${PG_GRAPHQL_SHA256}  /tmp/pg_graphql.deb" | sha256sum -c -; \
    dpkg --remove postgresql-18-pg-graphql 2>/dev/null || true; \
    dpkg -i /tmp/pg_graphql.deb; \
    grep -Fq "default_version = '${PG_GRAPHQL_VERSION}'" /usr/share/postgresql/18/extension/pg_graphql.control; \
    rm -f /tmp/pg_graphql.deb

RUN set -eu; if [ "$ENABLE_PG_DURABLE" = true ]; then \
      test "$(dpkg --print-architecture)" = amd64; \
      curl --http1.1 -fsSL --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 15 --max-time 300 \
        "${PG_DURABLE_DOWNLOAD_URL}" \
        -o /tmp/pg_durable.deb \
      && echo "${PG_DURABLE_SHA256}  /tmp/pg_durable.deb" | sha256sum -c - \
      && dpkg -i /tmp/pg_durable.deb \
      && rm -f /tmp/pg_durable.deb; \
    fi

COPY initdb /docker-entrypoint-initdb.d
COPY pgsodium_getkey /usr/share/postgresql/18/extension/pgsodium_getkey
COPY vault_getkey /usr/share/postgresql/18/extension/vault_getkey
RUN chmod 0755 \
    /usr/share/postgresql/18/extension/pgsodium_getkey \
    /usr/share/postgresql/18/extension/vault_getkey

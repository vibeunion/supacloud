FROM postgres:18-bookworm

ARG ENABLE_PG_DURABLE=false

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
      postgresql-18-pg-graphql \
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

RUN set -eu; if [ "$ENABLE_PG_DURABLE" = true ]; then \
      test "$(dpkg --print-architecture)" = amd64; \
      curl -fsSL --retry 3 --max-time 180 \
        https://github.com/microsoft/pg_durable/releases/download/v0.2.8/pg-durable-postgresql-18_0.2.8-1_amd64.deb \
        -o /tmp/pg_durable.deb \
      && echo '090028f59b003613b150e61ccd5cdbebe70e69e65361913ad29b1f0b6af9e2bb  /tmp/pg_durable.deb' | sha256sum -c - \
      && apt-get update \
      && apt-get install -y --no-install-recommends /tmp/pg_durable.deb \
      && rm -rf /var/lib/apt/lists/* /tmp/pg_durable.deb; \
    fi

COPY initdb /docker-entrypoint-initdb.d
COPY pgsodium_getkey /usr/share/postgresql/18/extension/pgsodium_getkey
COPY vault_getkey /usr/share/postgresql/18/extension/vault_getkey
RUN chmod 0755 \
    /usr/share/postgresql/18/extension/pgsodium_getkey \
    /usr/share/postgresql/18/extension/vault_getkey

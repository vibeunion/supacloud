FROM postgres:18-bookworm

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
      postgresql-18-pgjwt \
      postgresql-18-pgsodium \
      postgresql-18-hypopg \
      postgresql-18-index-advisor \
      postgresql-18-pg-stat-kcache \
      postgresql-18-pg-plan-filter \
      postgresql-18-supautils \
      postgresql-18-vault \
      postgresql-18-wal2json \
      postgresql-18-wrappers; \
    rm -rf /var/lib/apt/lists/*

COPY initdb /docker-entrypoint-initdb.d

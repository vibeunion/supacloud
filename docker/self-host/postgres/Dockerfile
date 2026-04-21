FROM postgres:18-bookworm

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates gnupg lsb-release; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      postgresql-18-cron \
      postgresql-18-pgaudit \
      postgresql-18-pgvector \
      postgresql-18-postgis-3 \
      postgresql-18-hypopg \
      postgresql-18-pg-stat-kcache \
      postgresql-18-wal2json \
      postgresql-contrib; \
    rm -rf /var/lib/apt/lists/*

COPY initdb /docker-entrypoint-initdb.d

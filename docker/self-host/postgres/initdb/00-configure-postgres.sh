#!/bin/bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v cron_database="$POSTGRES_DB" <<'SQL'
ALTER SYSTEM SET cron.database_name = :'cron_database';
ALTER SYSTEM SET wal_level = 'logical';
ALTER SYSTEM SET max_wal_senders = '10';
ALTER SYSTEM SET max_replication_slots = '10';
ALTER SYSTEM SET track_io_timing = 'on';
ALTER SYSTEM SET log_min_duration_statement = '1000';
SQL

cat >> "$PGDATA/postgresql.conf" <<'EOF'
shared_preload_libraries = 'pg_stat_statements, pg_cron, pgaudit, pg_net, pg_stat_kcache, plan_filter, pg_documentdb, pg_documentdb_core'
EOF

pg_ctl -D "$PGDATA" -m fast -w restart

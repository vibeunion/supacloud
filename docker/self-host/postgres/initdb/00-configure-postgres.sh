#!/bin/bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements,pg_cron,pgaudit';
ALTER SYSTEM SET cron.database_name = 'postgres';
ALTER SYSTEM SET wal_level = 'logical';
ALTER SYSTEM SET max_wal_senders = '10';
ALTER SYSTEM SET max_replication_slots = '10';
ALTER SYSTEM SET track_io_timing = 'on';
ALTER SYSTEM SET log_min_duration_statement = '1000';
SQL

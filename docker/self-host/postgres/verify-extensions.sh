#!/usr/bin/env bash
set -euo pipefail

# Use an isolated cluster, never the image consumer's PGDATA or TCP port.
work="$(mktemp -d)"
cleanup() {
  pg_ctl -D "$work/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
initdb -D "$work/data" --auth-local=trust --auth-host=reject >/dev/null
if ! pg_ctl -D "$work/data" -l "$work/postgres.log" -w start \
  -o "-c listen_addresses='' -c unix_socket_directories='$work' -c shared_preload_libraries=pg_durable -c pg_durable.database=postgres -c pg_durable.host='$work' -c pg_durable.enable_superuser_instances=off -c pg_durable.log_workflow_sql=off"; then
  cat "$work/postgres.log" >&2
  exit 1
fi
psql -X -h "$work" -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION pg_durable VERSION '0.2.8';
CREATE EXTENSION pg_graphql VERSION '1.6.2';
DO $$
BEGIN
  IF (SELECT extversion FROM pg_extension WHERE extname = 'pg_durable') IS DISTINCT FROM '0.2.8'
     OR (SELECT extversion FROM pg_extension WHERE extname = 'pg_graphql') IS DISTINCT FROM '1.6.2'
     OR (SELECT default_version FROM pg_available_extensions WHERE name = 'pg_durable') IS DISTINCT FROM '0.2.8'
     OR (SELECT default_version FROM pg_available_extensions WHERE name = 'pg_graphql') IS DISTINCT FROM '1.6.2' THEN
    RAISE EXCEPTION 'PostgreSQL image extension version contract failed';
  END IF;
END $$;
SELECT extname, extversion FROM pg_extension
WHERE extname IN ('pg_durable', 'pg_graphql') ORDER BY extname;
SQL

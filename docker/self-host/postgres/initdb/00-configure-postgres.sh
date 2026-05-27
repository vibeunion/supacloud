#!/bin/bash
set -euo pipefail

. /docker-entrypoint-initdb.d/00-common.sh

bool_setting() {
  case "${1,,}" in
    1 | true | yes | on) printf 'on' ;;
    0 | false | no | off | '') printf 'off' ;;
    *)
      echo "Invalid boolean value for $2: $1" >&2
      exit 1
      ;;
  esac
}

validate_config_path() {
  case "$1" in
    /*) ;;
    *)
      echo "PGSODIUM_KEY_FILE must be an absolute path" >&2
      exit 1
      ;;
  esac

  case "$1" in
    *"'"* | *$'\n'*)
      echo "PGSODIUM_KEY_FILE must not contain quotes or newlines" >&2
      exit 1
      ;;
  esac
}

shared_preload_libraries="pg_stat_statements, pg_cron, pgaudit, pg_net, pg_stat_kcache, plan_filter, pg_documentdb, pg_documentdb_core"

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

if truthy "${ENABLE_PGSODIUM:-false}"; then
  shared_preload_libraries="$shared_preload_libraries, pgsodium"
  pgsodium_key_file="${PGSODIUM_KEY_FILE:-/run/secrets/pgsodium_key}"
  pgsodium_event_trigger="$(bool_setting "${PGSODIUM_ENABLE_EVENT_TRIGGER:-off}" PGSODIUM_ENABLE_EVENT_TRIGGER)"
  validate_config_path "$pgsodium_key_file"
fi

cat >> "$PGDATA/postgresql.conf" <<EOF
shared_preload_libraries = '$shared_preload_libraries'
EOF

if truthy "${ENABLE_PGSODIUM:-false}"; then
  cat >> "$PGDATA/postgresql.conf" <<EOF
pgsodium.getkey_script = '/usr/share/postgresql/18/extension/pgsodium_getkey'
pgsodium.enable_event_trigger = '$pgsodium_event_trigger'
EOF
fi

pg_ctl -D "$PGDATA" -m fast -w restart

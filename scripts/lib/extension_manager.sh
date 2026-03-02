#!/bin/bash

# extension_manager.sh
# Manage PostgreSQL extensions (CREATE/DROP EXTENSION)

set -e

COMMAND=$1
DB_NAME=$2
EXT_NAME=$3

# Get PostgreSQL connection info from environment variables or default values
PG_HOST="${PG_HOST:-${POSTGRES_HOST:-localhost}}"
PG_PORT="${PG_PORT:-${POSTGRES_PORT:-6432}}"
PG_USER="${PG_USER:-postgres}"

run_sql() {
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB_NAME" -t -A -c "$1"
}

case $COMMAND in
    list)
        # Get available and installed extensions
        run_sql "SELECT json_agg(t) FROM (
            SELECT 
                name, 
                default_version, 
                installed_version, 
                comment,
                (installed_version IS NOT NULL) as is_installed
            FROM pg_available_extensions 
            ORDER BY name
        ) t;"
        ;;

    enable)
        if [ -z "$EXT_NAME" ]; then echo "Extension name required" >&2; exit 1; fi
        run_sql "CREATE EXTENSION IF NOT EXISTS \"$EXT_NAME\" CASCADE;"
        echo "Extension $EXT_NAME enabled in $DB_NAME"
        ;;

    disable)
        if [ -z "$EXT_NAME" ]; then echo "Extension name required" >&2; exit 1; fi
        run_sql "DROP EXTENSION IF EXISTS \"$EXT_NAME\" CASCADE;"
        echo "Extension $EXT_NAME disabled in $DB_NAME"
        ;;

    *)
        echo "Usage: $0 {list|enable|disable} <db_name> [extension_name]"
        exit 1
        ;;
esac

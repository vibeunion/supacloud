#!/bin/bash
set -euo pipefail
. /docker-entrypoint-initdb.d/00-common.sh
if truthy "${ENABLE_PG_DURABLE:-false}"; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -c 'CREATE EXTENSION IF NOT EXISTS pg_durable'
fi

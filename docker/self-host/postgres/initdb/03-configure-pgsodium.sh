#!/bin/bash
set -euo pipefail

. /docker-entrypoint-initdb.d/00-common.sh

if ! truthy "${ENABLE_PGSODIUM:-false}"; then
  if truthy "${ENABLE_SUPABASE_VAULT:-false}"; then
    echo "ENABLE_SUPABASE_VAULT requires ENABLE_PGSODIUM=true" >&2
    exit 1
  fi
  exit 0
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgsodium CASCADE;
SQL

if truthy "${ENABLE_SUPABASE_VAULT:-false}"; then
  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" <<'SQL'
CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;
SQL
fi

#!/bin/bash
set -euo pipefail

if [[ "${ENABLE_FERRETDB:-false}" != "true" ]]; then
  echo "FerretDB bootstrap disabled; set ENABLE_FERRETDB=true before the first database initialization to enable it."
  exit 0
fi

ferretdb_user="${FERRETDB_USER:-ferretdb}"
ferretdb_password="${FERRETDB_PASSWORD:-}"
ferretdb_database="${FERRETDB_DATABASE:-$POSTGRES_DB}"

if [[ -z "$ferretdb_password" ]]; then
  echo "FERRETDB_PASSWORD is required when ENABLE_FERRETDB=true" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  -v ferretdb_user="$ferretdb_user" \
  -v ferretdb_password="$ferretdb_password" \
  -v ferretdb_database="$ferretdb_database" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'ferretdb_user', :'ferretdb_password')
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_roles
  WHERE rolname = :'ferretdb_user'
)\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'ferretdb_database', :'ferretdb_user')
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_database
  WHERE datname = :'ferretdb_database'
)\gexec

SELECT format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO %I', :'ferretdb_database', :'ferretdb_user')\gexec
SQL

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$ferretdb_database" \
  -v ferretdb_user="$ferretdb_user" <<'SQL'
CREATE EXTENSION IF NOT EXISTS documentdb CASCADE;
GRANT USAGE, CREATE ON SCHEMA public TO :"ferretdb_user";

CREATE TEMP TABLE ferretdb_bootstrap_user(name text);
INSERT INTO ferretdb_bootstrap_user VALUES (:'ferretdb_user');

DO $$
DECLARE
  ferretdb_role text := (SELECT name FROM ferretdb_bootstrap_user LIMIT 1);
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'documentdb_%' OR nspname = 'documentdb_core'
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, ferretdb_role);
    EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I TO %I', schema_name, ferretdb_role);
    EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I TO %I', schema_name, ferretdb_role);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I', schema_name, ferretdb_role);
  END LOOP;
END
$$;
SQL

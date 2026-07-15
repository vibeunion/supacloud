#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="check"
MANAGEMENT_ENV_FILE="${SUPACLOUD_MANAGEMENT_ENV_FILE:-/etc/supabase/management-api.env}"
COMPAT_PG_ENV_FILE="${SUPACLOUD_COMPAT_PG_ENV_FILE:-$MANAGEMENT_ENV_FILE}"
PIGSTY_ENV_FILE="${PIGSTY_SUPABASE_ENV:-${HOME}/pigsty/app/supabase/.env}"
PIGSTY_SUPABASE_DIR="${PIGSTY_SUPABASE_DIR:-$(dirname "$PIGSTY_ENV_FILE")}"
PGBOUNCER_AUTH_FILE="${PGBOUNCER_AUTH_FILE:-/etc/pgbouncer/userlist.txt}"
ANALYTICS_DB="${LOGFLARE_DB:-_supabase}"
ANALYTICS_SCHEMA="${LOGFLARE_SCHEMA:-_analytics}"
ANALYTICS_OWNER="${LOGFLARE_DB_OWNER:-supabase_admin}"
META_DB="${SUPACLOUD_META_DB:-supacloud_meta}"
ANALYTICS_MIGRATION_ID="pigsty-4.4-postgres-analytics-to-${ANALYTICS_DB}"
ANALYTICS_STOPPED_BY_SCRIPT=false
ANALYTICS_PREPARE_COMPLETED=false
ANALYTICS_WAS_RUNNING=false
ANALYTICS_SERVICE_PRESENT=false
ANALYTICS_RECREATE_AFTER_PREPARE=false
ANALYTICS_COMPOSE_CMD=()

usage() {
  cat <<'EOF'
Usage: bash scripts/upgrade_pigsty_4_4_compat.sh [--check|--apply|--prepare-analytics|--dry-run|--rollback-plan]

  --check          Read-only verification of Pigsty 4.4 compatibility objects.
  --apply          Idempotently create/repair Analytics, Studio views, and metadata columns.
  --prepare-analytics
                   Move legacy Analytics before starting the Pigsty 4.4 Logflare stack.
  --dry-run        Print the planned targets without changing PostgreSQL or files.
  --rollback-plan  Print safe rollback guidance. It never drops Analytics data automatically.

Run --apply after installing the matching SupaCloud management binary so
`supacloud --init-db` can encrypt and backfill opaque Secret Keys.
Use SUPACLOUD_COMPAT_PG_ENV_FILE for maintenance-only PostgreSQL connection
settings while keeping SUPACLOUD_MANAGEMENT_ENV_FILE on the real runtime env.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check|--apply|--prepare-analytics|--dry-run|--rollback-plan)
      MODE="${1#--}"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$MODE" == "rollback-plan" ]]; then
  cat <<EOF
Rollback guidance:
1. Back up ${ANALYTICS_DB} before any destructive action.
2. Restore the previous Pigsty application files and Logflare environment.
3. Optional Studio wrapper rollback, per project database:
   DROP FUNCTION IF EXISTS extensions.pg_stat_statements(boolean);
   DROP VIEW IF EXISTS extensions.pg_stat_statements;
   DROP VIEW IF EXISTS extensions.pg_stat_statements_info;
4. Keep publishable_key/secret_key_* metadata columns during rollback; older binaries ignore them.
5. Recreate the Analytics service after restoring its environment so Docker applies the restored values.
6. Do not drop ${ANALYTICS_DB} automatically. Restore or remove it only after confirming its backup.
7. Before --apply, save pg_get_functiondef output for public.set_request_context(), auth.uid(),
   auth.jwt(), auth.role(), and public.soft_delete_user_if_no_active_tasks(), plus the auth.users
   trigger definition. Reapply those definitions to undo compatibility function changes.
8. Restore ${PGBOUNCER_AUTH_FILE}.pre-pigsty-4.4-* only after checking that its saved structure is valid.
9. Revoke dbuser_monitor CONNECT only on databases where the saved privilege baseline proves it was absent.
EOF
  exit 0
fi

if [[ -f "${SCRIPT_DIR}/lib/install_config.sh" ]]; then
  # shellcheck source=scripts/lib/install_config.sh
  source "${SCRIPT_DIR}/lib/install_config.sh"
fi

read_env_default() {
  local key="$1"
  local fallback="${2:-}"
  local value=""
  if declare -F supacloud_env_value >/dev/null 2>&1 && [[ -f "$COMPAT_PG_ENV_FILE" ]]; then
    value="$(supacloud_env_value "$COMPAT_PG_ENV_FILE" "$key")"
  fi
  printf '%s' "${value:-$fallback}"
}

PGHOST="${PGHOST:-$(read_env_default PG_HOST "")}"
PGPORT="${PGPORT:-$(read_env_default PG_PORT 5432)}"
PGUSER="${PGUSER:-$(read_env_default PG_USER postgres)}"
PGPASSWORD="${PGPASSWORD:-$(read_env_default PGPASSWORD "")}"
PSQL_BIN="${PSQL_BIN:-psql}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"

for identifier in "$ANALYTICS_DB" "$ANALYTICS_SCHEMA" "$ANALYTICS_OWNER" "$META_DB"; do
  if [[ ! "$identifier" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    printf 'Unsafe PostgreSQL identifier: %s\n' "$identifier" >&2
    exit 2
  fi
done

if ! command -v "$PSQL_BIN" >/dev/null 2>&1; then
  printf 'psql is required but was not found\n' >&2
  exit 1
fi

run_psql() {
  local database="$1"
  shift
  local args=("$PSQL_BIN" -X -v ON_ERROR_STOP=1 -p "$PGPORT" -U "$PGUSER" -d "$database")
  [[ -z "$PGHOST" ]] || args+=( -h "$PGHOST" )
  if [[ -z "$PGHOST" && "$(id -u)" -eq 0 ]] && command -v sudo >/dev/null 2>&1; then
    sudo -u postgres "${args[@]}" "$@"
  else
    PGPASSWORD="$PGPASSWORD" "${args[@]}" "$@"
  fi
}

run_psql_with_role_password() {
  local database="$1"
  shift
  local args=("$PSQL_BIN" -X -v ON_ERROR_STOP=1 -p "$PGPORT" -U "$PGUSER" -d "$database")
  [[ -z "$PGHOST" ]] || args+=( -h "$PGHOST" )
  export ROLE_PASSWORD
  if [[ -z "$PGHOST" && "$(id -u)" -eq 0 ]] && command -v sudo >/dev/null 2>&1; then
    sudo --preserve-env=ROLE_PASSWORD -u postgres "${args[@]}" "$@"
  else
    PGPASSWORD="$PGPASSWORD" ROLE_PASSWORD="$ROLE_PASSWORD" "${args[@]}" "$@"
  fi
}

run_tenant_psql() {
  local role="$1"
  local password="$2"
  local database="$3"
  shift 3
  local tenant_host="${PGHOST:-127.0.0.1}"
  PGPASSWORD="$password" "$PSQL_BIN" -X -v ON_ERROR_STOP=1 \
    -h "$tenant_host" -p "$PGPORT" -U "$role" -d "$database" "$@"
}

query_scalar() {
  local database="$1"
  local sql="$2"
  run_psql "$database" -Atqc "$sql"
}

run_pg_dump() {
  local database="$1"
  shift
  local args=("$PG_DUMP_BIN" -p "$PGPORT" -U "$PGUSER" -d "$database")
  [[ -z "$PGHOST" ]] || args+=( -h "$PGHOST" )
  if [[ -z "$PGHOST" && "$(id -u)" -eq 0 ]] && command -v sudo >/dev/null 2>&1; then
    sudo -u postgres "${args[@]}" "$@"
  else
    PGPASSWORD="$PGPASSWORD" "${args[@]}" "$@"
  fi
}

database_exists() {
  local database="$1"
  local result
  [[ "$database" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  if ! result="$(query_scalar postgres "SELECT 1 FROM pg_database WHERE datname = '$database'")"; then
    printf '[FAIL] Failed to inspect PostgreSQL database catalog while checking %s.\n' "$database" >&2
    return 2
  fi
  [[ "$result" == "1" ]]
}

list_target_databases() {
  printf '%s\n' postgres
  if database_exists "$META_DB"; then
    local databases
    if ! databases="$(query_scalar "$META_DB" "SELECT DISTINCT db_name FROM projects WHERE deleted_at IS NULL AND lower(status) = 'active' AND db_name IS NOT NULL ORDER BY db_name")"; then
      printf '[FAIL] Failed to enumerate active project databases from %s.\n' "$META_DB" >&2
      return 1
    fi
    while IFS= read -r database; do
      [[ -n "$database" ]] || continue
      if database_exists "$database"; then
        printf '%s\n' "$database"
      else
        local database_status=$?
        if [[ "$database_status" -eq 1 ]]; then
          printf '[WARN] Skipping missing or unsafe tenant database: %s\n' "$database" >&2
        else
          return "$database_status"
        fi
      fi
    done <<< "$databases"
  else
    local meta_status=$?
    [[ "$meta_status" -eq 1 ]] || return "$meta_status"
  fi
}

list_active_tenant_credentials() {
  if database_exists "$META_DB"; then
    query_scalar "$META_DB" "
      SELECT ref || chr(9) || db_name || chr(9)
        || coalesce(encode(convert_to(db_password, 'UTF8'), 'base64'), '')
      FROM projects
      WHERE deleted_at IS NULL
        AND lower(status) = 'active'
        AND ref IS NOT NULL
        AND db_name IS NOT NULL
      ORDER BY ref"
  else
    local meta_status=$?
    [[ "$meta_status" -eq 1 ]] || return "$meta_status"
  fi
}

apply_tenant_authenticator_compat() {
  local records
  if ! records="$(list_active_tenant_credentials)"; then
    printf '[FAIL] Failed to enumerate active tenant credentials from %s.\n' "$META_DB" >&2
    return 1
  fi

  while IFS=$'\t' read -r ref database password_base64; do
    [[ -n "$ref" ]] || continue
    if [[ ! "$ref" =~ ^[A-Za-z0-9_]+$ || ! "$database" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      printf '[FAIL] Unsafe active tenant identifier: ref=%s database=%s\n' "$ref" "$database" >&2
      return 1
    fi
    if ! database_exists "$database"; then
      local database_status=$?
      if [[ "$database_status" -eq 1 ]]; then
        printf '[FAIL] Active tenant database is missing: %s\n' "$database" >&2
      fi
      return 1
    fi
    if [[ -z "$password_base64" ]]; then
      printf '[FAIL] Active tenant database password is missing: %s\n' "$ref" >&2
      return 1
    fi

    local database_password authenticator_role
    if ! database_password="$(printf '%s' "$password_base64" | base64 --decode)"; then
      printf '[FAIL] Active tenant database password is not valid base64: %s\n' "$ref" >&2
      return 1
    fi
    authenticator_role="authenticator_${ref}"
    [[ "$authenticator_role" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && ${#authenticator_role} -le 63 ]] || {
      printf '[FAIL] Unsafe tenant authenticator role: %s\n' "$authenticator_role" >&2
      return 1
    }

    ROLE_PASSWORD="$database_password" run_psql_with_role_password postgres \
      -v authenticator_role="$authenticator_role" -v tenant_database="$database" <<'SQL'
\getenv role_password ROLE_PASSWORD
SELECT format('CREATE ROLE %I NOINHERIT LOGIN PASSWORD %L', :'authenticator_role', :'role_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'authenticator_role')
\gexec
SELECT format(
  'ALTER ROLE %I WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT LOGIN NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 30 PASSWORD %L',
  :'authenticator_role',
  :'role_password'
)
\gexec
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'authenticator_role', '15s')
\gexec
SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', :'authenticator_role', '30s')
\gexec
SELECT format('ALTER ROLE %I SET work_mem = %L', :'authenticator_role', '4MB')
\gexec
SELECT format('GRANT anon, authenticated, service_role TO %I', :'authenticator_role')
\gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'tenant_database', :'authenticator_role')
\gexec
SQL
    unset database_password ROLE_PASSWORD
  done <<< "$records"
}

check_tenant_authenticator_compat() {
  local ref="$1"
  local database="$2"
  local password_base64="$3"
  local authenticator_role="authenticator_${ref}"
  local role_result database_password

  if [[ ! "$ref" =~ ^[A-Za-z0-9_]+$ || ! "$database" =~ ^[A-Za-z_][A-Za-z0-9_]*$ \
    || ! "$authenticator_role" =~ ^[A-Za-z_][A-Za-z0-9_]*$ || ${#authenticator_role} -gt 63 ]]; then
    printf 'unsafe-identifier'
    return 0
  fi

  role_result="$(run_psql postgres -Atq \
    -v authenticator_role="$authenticator_role" -v tenant_database="$database" <<'SQL'
    SELECT CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = :'authenticator_role'
          AND rolcanlogin
          AND NOT rolinherit
          AND NOT rolsuper
          AND NOT rolcreatedb
          AND NOT rolcreaterole
          AND NOT rolreplication
          AND NOT rolbypassrls
          AND rolconnlimit = 30
          AND coalesce(rolconfig, ARRAY[]::text[]) @> ARRAY[
            'statement_timeout=15s',
            'idle_in_transaction_session_timeout=30s',
            'work_mem=4MB'
          ]
      ) THEN 'missing-or-incompatible-role'
      WHEN NOT pg_has_role(:'authenticator_role', 'anon', 'MEMBER')
        OR NOT pg_has_role(:'authenticator_role', 'authenticated', 'MEMBER')
        OR NOT pg_has_role(:'authenticator_role', 'service_role', 'MEMBER')
        OR NOT has_database_privilege(:'authenticator_role', :'tenant_database', 'CONNECT')
        OR NOT has_database_privilege(:'authenticator_role', :'tenant_database', 'TEMPORARY')
        THEN 'missing-grants'
      ELSE 'metadata-compatible'
    END
SQL
)"
  if [[ "$role_result" != "metadata-compatible" ]]; then
    printf '%s' "$role_result"
    return 0
  fi
  if [[ -z "$password_base64" ]] \
    || ! database_password="$(printf '%s' "$password_base64" | base64 --decode)"; then
    printf 'missing-password'
    return 0
  fi
  if run_tenant_psql "$authenticator_role" "$database_password" "$database" -Atqc 'SELECT 1' >/dev/null 2>&1; then
    printf 'compatible'
  else
    printf 'password-or-hba-failure'
  fi
  unset database_password
}

reconcile_management_pgpassword_alias() {
  [[ -f "$MANAGEMENT_ENV_FILE" ]] || return 0
  if ! declare -F supacloud_env_value >/dev/null 2>&1 \
    || ! declare -F supacloud_write_service_env_pairs >/dev/null 2>&1; then
    printf '[FAIL] Cannot safely reconcile PGPASSWORD without install_config.sh helpers.\n' >&2
    return 1
  fi
  local pgpassword pg_password
  pgpassword="$(supacloud_env_value "$MANAGEMENT_ENV_FILE" PGPASSWORD)"
  pg_password="$(supacloud_env_value "$MANAGEMENT_ENV_FILE" PG_PASSWORD)"
  if [[ -z "$pgpassword" && -n "$pg_password" ]]; then
    supacloud_write_service_env_pairs "$MANAGEMENT_ENV_FILE" PGPASSWORD "$pg_password"
    printf '[PASS] Reconciled management PGPASSWORD alias without exposing its value\n'
  fi
}

check_management_pgpassword_alias() {
  [[ -f "$MANAGEMENT_ENV_FILE" ]] || return 0
  if ! declare -F supacloud_env_value >/dev/null 2>&1; then
    printf 'helper-unavailable'
    return 0
  fi
  local pgpassword pg_password
  pgpassword="$(supacloud_env_value "$MANAGEMENT_ENV_FILE" PGPASSWORD)"
  pg_password="$(supacloud_env_value "$MANAGEMENT_ENV_FILE" PG_PASSWORD)"
  if [[ -z "$pgpassword" && -n "$pg_password" ]]; then
    printf 'empty-alias'
  else
    printf 'compatible'
  fi
}

repair_pgbouncer_auth_file() {
  [[ -f "$PGBOUNCER_AUTH_FILE" ]] || return 0
  local invalid_lines unexpected_lines
  invalid_lines="$(awk 'NF && $0 !~ /^"[^"]+" "[^"]*"$/ { count++ } END { print count + 0 }' "$PGBOUNCER_AUTH_FILE")"
  [[ "$invalid_lines" != "0" ]] || return 0
  unexpected_lines="$(awk 'NF && $0 !~ /^"[^"]+" "[^"]*"$/ && $0 !~ /^Time: [0-9]+([.][0-9]+)? ms$/ { count++ } END { print count + 0 }' "$PGBOUNCER_AUTH_FILE")"
  if [[ "$unexpected_lines" != "0" ]]; then
    printf '[FAIL] Refusing to rewrite a broken PgBouncer auth file with unknown content: %s\n' "$PGBOUNCER_AUTH_FILE" >&2
    return 1
  fi

  local temp_file owner_uid owner_gid file_mode backup_file
  owner_uid="$(stat -c '%u' "$PGBOUNCER_AUTH_FILE")"
  owner_gid="$(stat -c '%g' "$PGBOUNCER_AUTH_FILE")"
  file_mode="$(stat -c '%a' "$PGBOUNCER_AUTH_FILE")"
  backup_file="${PGBOUNCER_AUTH_FILE}.pre-pigsty-4.4-compat"
  [[ -e "$backup_file" ]] || cp -p "$PGBOUNCER_AUTH_FILE" "$backup_file"
  temp_file="$(mktemp "${PGBOUNCER_AUTH_FILE}.XXXXXX")"
  if ! awk '!/^Time: [0-9]+([.][0-9]+)? ms$/' "$PGBOUNCER_AUTH_FILE" > "$temp_file"; then
    rm -f "$temp_file"
    return 1
  fi
  if ! awk 'NF && $0 !~ /^"[^"]+" "[^"]*"$/ { exit 1 }' "$temp_file"; then
    printf '[FAIL] PgBouncer auth file remains malformed after removing known timing noise.\n' >&2
    rm -f "$temp_file"
    return 1
  fi
  if ! chown "$owner_uid:$owner_gid" "$temp_file" \
    || ! chmod "$file_mode" "$temp_file" \
    || ! mv -f "$temp_file" "$PGBOUNCER_AUTH_FILE"; then
    rm -f "$temp_file"
    return 1
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet pgbouncer.service; then
    systemctl reload pgbouncer.service
  fi
  printf '[PASS] Repaired known Pigsty timing noise in the PgBouncer auth file\n'
}

check_pgbouncer_auth_file() {
  [[ -f "$PGBOUNCER_AUTH_FILE" ]] || {
    printf 'not-present'
    return 0
  }
  if awk 'NF && $0 !~ /^"[^"]+" "[^"]*"$/ { exit 1 }' "$PGBOUNCER_AUTH_FILE"; then
    printf 'compatible'
  else
    printf 'broken'
  fi
}

apply_monitor_connect_compat() {
  if [[ "$(query_scalar postgres "SELECT 1 FROM pg_roles WHERE rolname = 'dbuser_monitor'")" != "1" ]]; then
    return 0
  fi
  run_psql postgres <<'SQL'
SELECT format('GRANT CONNECT ON DATABASE %I TO dbuser_monitor', datname)
FROM pg_database
WHERE datallowconn AND NOT datistemplate
\gexec
SQL
}

check_monitor_connect_compat() {
  if [[ "$(query_scalar postgres "SELECT 1 FROM pg_roles WHERE rolname = 'dbuser_monitor'")" != "1" ]]; then
    printf 'not-present'
    return 0
  fi
  query_scalar postgres "
    SELECT count(*)
    FROM pg_database
    WHERE datallowconn
      AND NOT datistemplate
      AND NOT has_database_privilege('dbuser_monitor', datname, 'CONNECT')"
}

apply_pg_stat_compat() {
  local database="$1"
  run_psql "$database" <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

DO $compat$
DECLARE
  source_schema TEXT;
BEGIN
  SELECT n.nspname INTO source_schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_stat_statements';

  IF source_schema IS NOT NULL AND source_schema <> 'extensions' THEN
    IF to_regclass(format('%I.pg_stat_statements', source_schema)) IS NOT NULL THEN
      EXECUTE format('CREATE OR REPLACE VIEW extensions.pg_stat_statements AS SELECT * FROM %I.pg_stat_statements', source_schema);
    END IF;
    IF to_regclass(format('%I.pg_stat_statements_info', source_schema)) IS NOT NULL THEN
      EXECUTE format('CREATE OR REPLACE VIEW extensions.pg_stat_statements_info AS SELECT * FROM %I.pg_stat_statements_info', source_schema);
    END IF;
    IF to_regprocedure(format('%I.pg_stat_statements(boolean)', source_schema)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE OR REPLACE FUNCTION extensions.pg_stat_statements(showtext boolean) RETURNS SETOF %I.pg_stat_statements LANGUAGE sql STABLE AS $function$ SELECT * FROM %I.pg_stat_statements(showtext); $function$',
        source_schema,
        source_schema
      );
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
      IF to_regclass('extensions.pg_stat_statements') IS NOT NULL THEN
        ALTER VIEW extensions.pg_stat_statements OWNER TO supabase_admin;
      END IF;
      IF to_regclass('extensions.pg_stat_statements_info') IS NOT NULL THEN
        ALTER VIEW extensions.pg_stat_statements_info OWNER TO supabase_admin;
      END IF;
      IF to_regprocedure('extensions.pg_stat_statements(boolean)') IS NOT NULL THEN
        ALTER FUNCTION extensions.pg_stat_statements(boolean) OWNER TO supabase_admin;
      END IF;
    END IF;
  END IF;
END
$compat$;
SQL
}

check_pg_stat_compat() {
  local database="$1"
  query_scalar "$database" "
    WITH ext AS (
      SELECT n.nspname AS schema_name
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pg_stat_statements'
    )
    SELECT CASE
      WHEN NOT EXISTS (SELECT 1 FROM ext) THEN 'missing-extension'
      WHEN (SELECT schema_name FROM ext) = 'extensions' THEN 'native'
      WHEN to_regclass('extensions.pg_stat_statements') IS NOT NULL
       AND to_regclass('extensions.pg_stat_statements_info') IS NOT NULL
       AND to_regprocedure('extensions.pg_stat_statements(boolean)') IS NOT NULL THEN 'compatible'
      ELSE 'missing-wrappers'
    END"
}

apply_postgrest_prerequest_compat() {
  local database="$1"
  run_psql "$database" <<'SQL'
CREATE OR REPLACE FUNCTION public.set_request_context() RETURNS void AS $$
DECLARE
  claims jsonb;
  role_claim text;
BEGIN
  BEGIN
    claims := COALESCE(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN invalid_text_representation THEN
    claims := '{}'::jsonb;
  END;

  PERFORM set_config('request.jwt.claims', claims::text, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(claims ->> 'sub', ''), true);
  PERFORM set_config('request.jwt.claim.email', coalesce(claims ->> 'email', ''), true);

  role_claim := COALESCE(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    claims ->> 'role',
    'anon'
  );
  PERFORM set_config('request.jwt.claim.role', role_claim, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.set_request_context() TO anon, authenticated, service_role;
COMMENT ON FUNCTION public.set_request_context() IS 'supacloud:pigsty-4.4-postgrest-prerequest:v1';
SQL
}

check_postgrest_prerequest_compat() {
  local database="$1"
  query_scalar "$database" "
    SELECT CASE
      WHEN p.oid IS NULL THEN 'missing'
      WHEN p.provolatile = 'v'
       AND p.prosecdef
       AND obj_description(p.oid, 'pg_proc') = 'supacloud:pigsty-4.4-postgrest-prerequest:v1'
       AND position('perform set_config(''request.jwt.claim.sub'', coalesce(claims ->> ''sub'', ''''), true);' IN
         regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g')) > 0
       AND position('perform set_config(''request.jwt.claim.email'', coalesce(claims ->> ''email'', ''''), true);' IN
         regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g')) > 0
       AND position('perform set_config(''request.jwt.claim.role'', role_claim, true);' IN
         regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g')) > 0
       AND position('set local role' IN lower(p.prosrc)) = 0
       AND position('set_config(''role''' IN lower(p.prosrc)) = 0
        THEN 'compatible'
      ELSE 'incompatible'
    END
    FROM (SELECT to_regprocedure('public.set_request_context()') AS oid) target
    LEFT JOIN pg_proc p ON p.oid = target.oid"
}

apply_auth_jwt_helpers_compat() {
  local database="$1"
  [[ "$(query_scalar "$database" "SELECT to_regnamespace('auth') IS NOT NULL")" == "t" ]] || return 0

  run_psql "$database" <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
BEGIN
  RETURN COALESCE(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$
  SELECT COALESCE(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
$$ LANGUAGE SQL STABLE;

COMMENT ON FUNCTION auth.uid() IS 'supacloud:pigsty-4.4-auth-jwt-helpers:v1';
COMMENT ON FUNCTION auth.jwt() IS 'supacloud:pigsty-4.4-auth-jwt-helpers:v1';
COMMENT ON FUNCTION auth.role() IS 'supacloud:pigsty-4.4-auth-jwt-helpers:v1';
SQL
}

check_auth_jwt_helpers_compat() {
  local database="$1"
  query_scalar "$database" "
    WITH helpers AS (
      SELECT
        to_regprocedure('auth.uid()') AS uid_oid,
        to_regprocedure('auth.jwt()') AS jwt_oid,
        to_regprocedure('auth.role()') AS role_oid
    ), source AS (
      SELECT
        uid_oid,
        jwt_oid,
        role_oid,
        lower(coalesce((SELECT prosrc FROM pg_proc WHERE oid = uid_oid), '')) AS uid_source,
        lower(coalesce((SELECT prosrc FROM pg_proc WHERE oid = jwt_oid), '')) AS jwt_source,
        lower(coalesce((SELECT prosrc FROM pg_proc WHERE oid = role_oid), '')) AS role_source
      FROM helpers
    )
    SELECT CASE
      WHEN to_regnamespace('auth') IS NULL THEN 'missing-schema'
      WHEN uid_oid IS NULL OR jwt_oid IS NULL OR role_oid IS NULL THEN 'missing-helper'
      WHEN obj_description(uid_oid, 'pg_proc') = 'supacloud:pigsty-4.4-auth-jwt-helpers:v1'
       AND obj_description(jwt_oid, 'pg_proc') = 'supacloud:pigsty-4.4-auth-jwt-helpers:v1'
       AND obj_description(role_oid, 'pg_proc') = 'supacloud:pigsty-4.4-auth-jwt-helpers:v1'
       AND position('request.jwt.claim.sub' IN uid_source) > 0
       AND position('request.jwt.claims' IN uid_source) > 0
       AND position('->> ''sub''' IN uid_source) > 0
       AND position('request.jwt.claims' IN jwt_source) > 0
       AND position('request.jwt.claim.role' IN role_source) > 0
       AND position('request.jwt.claims' IN role_source) > 0
       AND position('->> ''role''' IN role_source) > 0
        THEN 'compatible'
      ELSE 'incompatible'
    END
    FROM source"
}

apply_auth_delete_fence_compat() {
  local database="$1"
  local applicable
  applicable="$(query_scalar "$database" "
    SELECT CASE
      WHEN to_regclass('auth.users') IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.has_active_background_tasks(uuid)')
           AND p.prorettype = 'text'::regtype
       )
        THEN 'yes'
      ELSE 'no'
    END")"
  [[ "$applicable" == "yes" ]] || return 0

  run_psql "$database" <<'SQL'
BEGIN;

CREATE OR REPLACE FUNCTION public.soft_delete_user_if_no_active_tasks()
RETURNS TRIGGER AS $$
DECLARE
  v_task_state TEXT;
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RETURN OLD;
  END IF;

  v_task_state := public.has_active_background_tasks(OLD.id);

  IF v_task_state = 'inactive' THEN
    -- 未发现活跃任务时，允许原 DELETE 继续，禁止先更新同一行。
    RETURN OLD;
  END IF;

  -- 活跃或未知状态采取保守策略：软删除并取消原硬删除。
  UPDATE auth.users SET deleted_at = NOW() WHERE id = OLD.id;

  IF v_task_state = 'unknown' THEN
    RAISE NOTICE 'soft_delete_user_if_no_active_tasks: degraded/unknown for user %, blocking hard delete', OLD.id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.soft_delete_user_if_no_active_tasks()
  IS 'supacloud:pigsty-4.4-auth-delete-fence:v1';

DROP TRIGGER IF EXISTS auth_users_delete_fence ON auth.users;
CREATE TRIGGER auth_users_delete_fence
  BEFORE DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.soft_delete_user_if_no_active_tasks();

COMMIT;
SQL
}

check_auth_delete_fence_compat() {
  local database="$1"
  query_scalar "$database" "
    WITH target AS (
      SELECT p.oid,
        p.proname,
        p.prorettype,
        p.prosecdef,
        t.tgenabled,
        t.tgtype,
        position('/*' IN lower(p.prosrc)) > 0 AS has_block_comment,
        regexp_replace(
          regexp_replace(lower(p.prosrc), E'--[^\\n\\r]*', ' ', 'g'),
          '[[:space:]]+',
          ' ',
          'g'
        ) AS source
      FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = to_regclass('auth.users')
        AND t.tgname = 'auth_users_delete_fence'
        AND NOT t.tgisinternal
    ), helper AS (
      SELECT p.prorettype = 'text'::regtype AS returns_text
      FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.has_active_background_tasks(uuid)')
    )
    SELECT CASE
      WHEN to_regclass('auth.users') IS NULL
        OR NOT COALESCE((SELECT returns_text FROM helper), false)
        THEN 'not-applicable'
      WHEN NOT EXISTS (SELECT 1 FROM target) THEN 'incompatible'
      WHEN (SELECT proname FROM target) = 'soft_delete_user_if_no_active_tasks'
       AND (SELECT prorettype FROM target) = 'trigger'::regtype
       AND (SELECT prosecdef FROM target)
       AND (SELECT t.tgenabled IN ('O', 'A') FROM target t)
       AND (SELECT t.tgtype = 11 FROM target t)
       AND NOT (SELECT has_block_comment FROM target)
       AND obj_description((SELECT oid FROM target), 'pg_proc') = 'supacloud:pigsty-4.4-auth-delete-fence:v1'
       AND position('v_task_state := public.has_active_background_tasks(old.id);' IN (SELECT source FROM target)) > 0
       AND (SELECT source FROM target) ~ 'if v_task_state = ''inactive'' then return old; end if; update auth[.]users set deleted_at = now[(][)] where id = old[.]id;'
       AND position('update auth.users set deleted_at = now() where id = old.id;' IN (SELECT source FROM target))
         > position('v_task_state := public.has_active_background_tasks(old.id);' IN (SELECT source FROM target))
       AND position('return null;' IN (SELECT source FROM target))
         > position('update auth.users set deleted_at = now() where id = old.id;' IN (SELECT source FROM target))
        THEN 'compatible'
      ELSE 'incompatible'
    END"
}

apply_analytics_database() {
  if [[ "$(query_scalar postgres "SELECT 1 FROM pg_roles WHERE rolname = '$ANALYTICS_OWNER'")" != "1" ]]; then
    printf 'Required Analytics owner role does not exist: %s\n' "$ANALYTICS_OWNER" >&2
    return 1
  fi

  run_psql postgres -v analytics_db="$ANALYTICS_DB" -v analytics_owner="$ANALYTICS_OWNER" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'analytics_db', :'analytics_owner')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'analytics_db')
\gexec
SQL

  run_psql "$ANALYTICS_DB" -v analytics_schema="$ANALYTICS_SCHEMA" -v analytics_owner="$ANALYTICS_OWNER" <<'SQL'
SELECT format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', :'analytics_schema', :'analytics_owner')
\gexec
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE TABLE IF NOT EXISTS public.supacloud_compat_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
SQL
}

analytics_relation_count() {
  local database="$1"
  query_scalar "$database" "
    SELECT count(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '$ANALYTICS_SCHEMA' AND c.relkind IN ('r','p','v','m','S')"
}

analytics_migration_marked() {
  if [[ "$(query_scalar "$ANALYTICS_DB" "SELECT to_regclass('public.supacloud_compat_migrations') IS NOT NULL")" != "t" ]]; then
    return 1
  fi
  [[ "$(query_scalar "$ANALYTICS_DB" "
    SELECT 1 FROM public.supacloud_compat_migrations
    WHERE name = '$ANALYTICS_MIGRATION_ID'")" == "1" ]]
}

analytics_migration_required() {
  [[ "$(query_scalar postgres "SELECT 1 FROM pg_namespace WHERE nspname = '$ANALYTICS_SCHEMA'")" == "1" ]] || return 1
  [[ "$(analytics_relation_count postgres)" -gt 0 ]] || return 1
  ! analytics_migration_marked
}

migrate_legacy_analytics() {
  local source_database="postgres"
  local source_exists
  local source_relations
  local target_relations
  source_exists="$(query_scalar "$source_database" "SELECT 1 FROM pg_namespace WHERE nspname = '$ANALYTICS_SCHEMA'")"
  [[ "$source_exists" == "1" ]] || return 0

  source_relations="$(analytics_relation_count "$source_database")"
  [[ "${source_relations:-0}" -gt 0 ]] || return 0

  target_relations="$(analytics_relation_count "$ANALYTICS_DB")"
  if analytics_migration_marked; then
    if [[ "${target_relations:-0}" -gt 0 ]]; then
      printf '[PASS] Legacy Analytics migration was already completed.\n'
      return 0
    fi
    printf '[FAIL] Analytics migration marker exists but destination schema is empty.\n' >&2
    return 1
  fi
  if [[ "${target_relations:-0}" -gt 0 ]]; then
    printf '[FAIL] Both legacy and destination Analytics schemas are non-empty without a completion marker.\n' >&2
    printf '       Stop Logflare and resolve the destination before retrying; no data was overwritten.\n' >&2
    return 1
  fi

  if ! command -v "$PG_DUMP_BIN" >/dev/null 2>&1; then
    printf 'pg_dump is required to migrate legacy Analytics data\n' >&2
    return 1
  fi

  printf '[INFO] Migrating legacy %s.%s into %s.%s\n' \
    "$source_database" "$ANALYTICS_SCHEMA" "$ANALYTICS_DB" "$ANALYTICS_SCHEMA"
  local dump_file
  dump_file="$(mktemp)"
  chmod 600 "$dump_file"
  trap 'rm -f "$dump_file"' RETURN
  run_pg_dump "$source_database" \
    --schema="$ANALYTICS_SCHEMA" --no-owner --no-acl > "$dump_file"
  {
    sed -e '/^CREATE SCHEMA /d' -e '/^ALTER SCHEMA .* OWNER TO /d' "$dump_file"
    printf "\nINSERT INTO public.supacloud_compat_migrations(name, details) VALUES ('%s', jsonb_build_object('source_database','postgres','source_schema','%s','source_relations',%s)) ON CONFLICT (name) DO UPDATE SET applied_at = NOW(), details = EXCLUDED.details;\n" \
      "$ANALYTICS_MIGRATION_ID" "$ANALYTICS_SCHEMA" "$source_relations"
  } | run_psql "$ANALYTICS_DB" -1
  rm -f "$dump_file"
  trap - RETURN

}

grant_analytics_owner_privileges() {
  run_psql "$ANALYTICS_DB" -v analytics_schema="$ANALYTICS_SCHEMA" -v analytics_owner="$ANALYTICS_OWNER" <<'SQL'
SELECT format('ALTER SCHEMA %I OWNER TO %I', :'analytics_schema', :'analytics_owner')
\gexec
SELECT format('GRANT ALL ON SCHEMA %I TO %I', :'analytics_schema', :'analytics_owner')
\gexec
SELECT format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I TO %I', :'analytics_schema', :'analytics_owner')
\gexec
SELECT format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I TO %I', :'analytics_schema', :'analytics_owner')
\gexec
SELECT format('GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA %I TO %I', :'analytics_schema', :'analytics_owner')
\gexec
SQL
}

stop_legacy_analytics() {
  local compose_file="${PIGSTY_SUPABASE_DIR}/docker-compose.yml"
  local source_relations=0
  if [[ "$(query_scalar postgres "SELECT 1 FROM pg_namespace WHERE nspname = '$ANALYTICS_SCHEMA'")" == "1" ]]; then
    source_relations="$(analytics_relation_count postgres)"
  fi
  if [[ "${SUPACLOUD_ASSUME_ANALYTICS_STOPPED:-false}" == "true" ]]; then
    printf '[WARN] Skipping Analytics process verification because SUPACLOUD_ASSUME_ANALYTICS_STOPPED=true.\n' >&2
    return 0
  fi
  if [[ "${source_relations:-0}" -gt 0 && ! -f "$PIGSTY_ENV_FILE" ]]; then
    printf '[FAIL] Legacy Analytics data exists but the Pigsty Supabase environment is missing: %s\n' "$PIGSTY_ENV_FILE" >&2
    printf '       Stop the external writer manually and use SUPACLOUD_ASSUME_ANALYTICS_STOPPED=true only after verification.\n' >&2
    return 1
  fi
  if [[ ! -f "$compose_file" ]]; then
    if [[ "${source_relations:-0}" -gt 0 ]]; then
      printf '[FAIL] Legacy Analytics data exists but no managed compose file was found: %s\n' "$compose_file" >&2
      printf '       Stop the external writer manually and use SUPACLOUD_ASSUME_ANALYTICS_STOPPED=true only after verification.\n' >&2
      return 1
    fi
    return 0
  fi

  local -a compose_cmd=()
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    compose_cmd=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    compose_cmd=(docker-compose)
  elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    compose_cmd=(podman compose)
  else
    printf '[FAIL] Cannot verify the legacy Analytics container state for %s.\n' "$compose_file" >&2
    printf '       Stop Logflare manually, then set SUPACLOUD_ASSUME_ANALYTICS_STOPPED=true to continue.\n' >&2
    return 1
  fi

  local analytics_container=""
  local analytics_service=""
  if ! analytics_container="$(cd "$PIGSTY_SUPABASE_DIR" && "${compose_cmd[@]}" ps -q analytics 2>/dev/null)"; then
    printf '[FAIL] Unable to inspect the legacy Analytics container. Stop it manually before migration.\n' >&2
    return 1
  fi
  if ! analytics_service="$(cd "$PIGSTY_SUPABASE_DIR" && "${compose_cmd[@]}" ps -a -q analytics 2>/dev/null)"; then
    printf '[FAIL] Unable to inspect stopped Analytics containers.\n' >&2
    return 1
  fi
  ANALYTICS_COMPOSE_CMD=("${compose_cmd[@]}")
  [[ -z "$analytics_service" ]] || ANALYTICS_SERVICE_PRESENT=true
  if [[ -n "$analytics_container" ]]; then
    printf '[INFO] Stopping legacy Analytics to take a consistent migration snapshot.\n'
    (cd "$PIGSTY_SUPABASE_DIR" && "${compose_cmd[@]}" stop analytics)
    ANALYTICS_STOPPED_BY_SCRIPT=true
    ANALYTICS_WAS_RUNNING=true
  fi
}

pigsty_env_targets_analytics() {
  [[ -f "$PIGSTY_ENV_FILE" ]] || return 1
  [[ "$(supacloud_env_value "$PIGSTY_ENV_FILE" LOGFLARE_DB)" == "$ANALYTICS_DB" ]] || return 1
  [[ "$(supacloud_env_value "$PIGSTY_ENV_FILE" LOGFLARE_SCHEMA)" == "$ANALYTICS_SCHEMA" ]] || return 1
  local configured_url
  configured_url="$(supacloud_env_value "$PIGSTY_ENV_FILE" LOGFLARE_DATABASE_URL)"
  [[ -z "$configured_url" || "$configured_url" == */"$ANALYTICS_DB" || "$configured_url" == */"$ANALYTICS_DB"\?* ]]
}

restore_analytics_after_prepare_failure() {
  local exit_status=$?
  if [[ "$MODE" == "prepare-analytics" && "$ANALYTICS_STOPPED_BY_SCRIPT" == "true" && "$ANALYTICS_PREPARE_COMPLETED" != "true" ]]; then
    if analytics_migration_marked 2>/dev/null; then
      if pigsty_env_targets_analytics; then
        printf '[WARN] Analytics preparation failed after data migration; recreating the service against the migrated destination.\n' >&2
        (cd "$PIGSTY_SUPABASE_DIR" && "${ANALYTICS_COMPOSE_CMD[@]}" up -d --force-recreate analytics) || true
      else
        printf '[WARN] Analytics data migrated but the destination environment was not safely written; leaving the writer stopped.\n' >&2
      fi
    else
      printf '[WARN] Analytics preparation failed before data migration; restarting the legacy Analytics service.\n' >&2
      (cd "$PIGSTY_SUPABASE_DIR" && "${ANALYTICS_COMPOSE_CMD[@]}" start analytics) || true
    fi
  fi
  return "$exit_status"
}

start_prepared_analytics() {
  if [[ "$ANALYTICS_RECREATE_AFTER_PREPARE" == "true" && ${#ANALYTICS_COMPOSE_CMD[@]} -gt 0 ]]; then
    printf '[INFO] Recreating Analytics against %s.%s.\n' "$ANALYTICS_DB" "$ANALYTICS_SCHEMA"
    (cd "$PIGSTY_SUPABASE_DIR" && "${ANALYTICS_COMPOSE_CMD[@]}" up -d --force-recreate analytics)
  fi
}

recover_stopped_prepared_analytics() {
  local compose_file="${PIGSTY_SUPABASE_DIR}/docker-compose.yml"
  [[ -f "$compose_file" ]] || return 0
  [[ "${SUPACLOUD_ASSUME_ANALYTICS_STOPPED:-false}" != "true" ]] || return 0

  local -a compose_cmd=()
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    compose_cmd=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    compose_cmd=(docker-compose)
  elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    compose_cmd=(podman compose)
  else
    printf '[FAIL] Cannot inspect the prepared Analytics service for recovery.\n' >&2
    return 1
  fi

  local running_container=""
  local existing_container=""
  running_container="$(cd "$PIGSTY_SUPABASE_DIR" && "${compose_cmd[@]}" ps -q analytics)"
  existing_container="$(cd "$PIGSTY_SUPABASE_DIR" && "${compose_cmd[@]}" ps -a -q analytics)"
  if [[ -n "$existing_container" && -z "$running_container" ]]; then
    ANALYTICS_COMPOSE_CMD=("${compose_cmd[@]}")
    ANALYTICS_SERVICE_PRESENT=true
    ANALYTICS_RECREATE_AFTER_PREPARE=true
  fi
}

patch_pigsty_env() {
  [[ -f "$PIGSTY_ENV_FILE" ]] || return 0
  if ! declare -F supacloud_write_raw_env_pairs >/dev/null 2>&1; then
    printf 'Cannot safely update %s because install_config.sh is unavailable\n' "$PIGSTY_ENV_FILE" >&2
    return 1
  fi
  local current_url=""
  local updated_url=""
  local current_url_base=""
  local current_url_query=""
  current_url="$(supacloud_env_value "$PIGSTY_ENV_FILE" LOGFLARE_DATABASE_URL)"
  if [[ -n "$current_url" && "$current_url" == */* ]]; then
    current_url_base="$current_url"
    if [[ "$current_url" == *\?* ]]; then
      current_url_base="${current_url%%\?*}"
      current_url_query="?${current_url#*\?}"
    fi
    updated_url="${current_url_base%/*}/${ANALYTICS_DB}${current_url_query}"
  fi
  if [[ -n "$updated_url" ]]; then
    supacloud_write_raw_env_pairs "$PIGSTY_ENV_FILE" \
      LOGFLARE_DB "$ANALYTICS_DB" \
      LOGFLARE_SCHEMA "$ANALYTICS_SCHEMA" \
      LOGFLARE_DATABASE_URL "$updated_url"
  else
    supacloud_write_raw_env_pairs "$PIGSTY_ENV_FILE" \
      LOGFLARE_DB "$ANALYTICS_DB" \
      LOGFLARE_SCHEMA "$ANALYTICS_SCHEMA"
  fi
}

apply_metadata_columns() {
  if database_exists "$META_DB"; then
    :
  else
    local meta_status=$?
    [[ "$meta_status" -eq 1 ]] && return 0
    return "$meta_status"
  fi
  run_psql "$META_DB" <<'SQL'
ALTER TABLE projects ADD COLUMN IF NOT EXISTS publishable_key TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS secret_key_hash VARCHAR(64);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS secret_key_encrypted TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_publishable_key
  ON projects(publishable_key) WHERE publishable_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_secret_key_hash
  ON projects(secret_key_hash) WHERE secret_key_hash IS NOT NULL;
SQL
}

check_all() {
  local failed=0
  if database_exists "$ANALYTICS_DB"; then
    if [[ "$(query_scalar "$ANALYTICS_DB" "SELECT 1 FROM pg_namespace WHERE nspname = '$ANALYTICS_SCHEMA'")" != "1" ]]; then
      printf '[FAIL] Analytics schema missing: %s.%s\n' "$ANALYTICS_DB" "$ANALYTICS_SCHEMA"
      failed=1
    else
      printf '[PASS] Analytics isolated at %s.%s\n' "$ANALYTICS_DB" "$ANALYTICS_SCHEMA"
      if [[ "$(query_scalar postgres "SELECT 1 FROM pg_namespace WHERE nspname = '$ANALYTICS_SCHEMA'")" == "1" ]] \
        && [[ "$(analytics_relation_count postgres)" -gt 0 ]]; then
        if analytics_migration_marked && [[ "$(analytics_relation_count "$ANALYTICS_DB")" -gt 0 ]]; then
          printf '[PASS] Legacy Analytics migration completion marker is present\n'
        else
          printf '[FAIL] Legacy Analytics remains non-empty without a verified destination migration\n'
          failed=1
        fi
      fi
    fi
  else
    local analytics_status=$?
    if [[ "$analytics_status" -eq 1 ]]; then
      printf '[FAIL] Analytics database missing: %s\n' "$ANALYTICS_DB"
    fi
    failed=1
  fi

  local target_databases
  if ! target_databases="$(list_target_databases | awk '!seen[$0]++')"; then
    failed=1
  else
    while IFS= read -r database; do
      [[ -n "$database" ]] || continue
      local result
      result="$(check_pg_stat_compat "$database")"
      if [[ "$result" == "native" || "$result" == "compatible" ]]; then
        printf '[PASS] Studio pg_stat_statements compatibility: %s (%s)\n' "$database" "$result"
      else
        printf '[FAIL] Studio pg_stat_statements compatibility: %s (%s)\n' "$database" "$result"
        failed=1
      fi
      if [[ "$database" != "postgres" ]]; then
        local prerequest_result
        prerequest_result="$(check_postgrest_prerequest_compat "$database")"
        if [[ "$prerequest_result" == "compatible" ]]; then
          printf '[PASS] PostgREST pre-request compatibility: %s\n' "$database"
        else
          printf '[FAIL] PostgREST pre-request compatibility: %s (%s)\n' "$database" "$prerequest_result"
          failed=1
        fi
        local auth_jwt_helpers_result
        auth_jwt_helpers_result="$(check_auth_jwt_helpers_compat "$database")"
        if [[ "$auth_jwt_helpers_result" == "compatible" ]]; then
          printf '[PASS] Auth JWT helper compatibility: %s\n' "$database"
        else
          printf '[FAIL] Auth JWT helper compatibility: %s (%s)\n' "$database" "$auth_jwt_helpers_result"
          failed=1
        fi
        local auth_delete_fence_result
        auth_delete_fence_result="$(check_auth_delete_fence_compat "$database")"
        if [[ "$auth_delete_fence_result" == "compatible" ]]; then
          printf '[PASS] Auth user delete fence compatibility: %s\n' "$database"
        elif [[ "$auth_delete_fence_result" == "not-applicable" ]]; then
          printf '[PASS] Auth user delete fence not applicable: %s\n' "$database"
        else
          printf '[FAIL] Auth user delete fence compatibility: %s (%s)\n' "$database" "$auth_delete_fence_result"
          failed=1
        fi
      fi
    done <<< "$target_databases"
  fi

  local tenant_records
  if ! tenant_records="$(list_active_tenant_credentials)"; then
    failed=1
  else
    while IFS=$'\t' read -r ref database password_base64; do
      [[ -n "$ref" ]] || continue
      local authenticator_result
      authenticator_result="$(check_tenant_authenticator_compat "$ref" "$database" "$password_base64")"
      if [[ "$authenticator_result" == "compatible" ]]; then
        printf '[PASS] Tenant authenticator compatibility: %s (%s)\n' "$ref" "$database"
      else
        printf '[FAIL] Tenant authenticator compatibility: %s (%s)\n' "$ref" "$authenticator_result"
        failed=1
      fi
    done <<< "$tenant_records"
  fi

  if database_exists "$META_DB"; then
    local missing_columns
    missing_columns="$(query_scalar "$META_DB" "
      SELECT 3 - count(*)
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'projects'
        AND column_name IN ('publishable_key','secret_key_hash','secret_key_encrypted')")"
    if [[ "$missing_columns" != "0" ]]; then
      printf '[FAIL] Opaque API key metadata columns are incomplete\n'
      failed=1
    else
      printf '[PASS] Opaque API key metadata columns exist\n'
      local incomplete_keys
      incomplete_keys="$(query_scalar "$META_DB" "
        SELECT count(*) FROM projects
        WHERE deleted_at IS NULL AND (
          publishable_key IS NULL OR publishable_key NOT LIKE 'sb_publishable_%'
          OR secret_key_hash IS NULL OR secret_key_hash !~ '^[0-9a-f]{64}$'
          OR secret_key_encrypted IS NULL OR secret_key_encrypted NOT LIKE 'enc:v1:%'
        )")"
      if [[ "${incomplete_keys:-0}" != "0" ]]; then
        printf '[FAIL] %s active project(s) still need opaque API key backfill\n' "$incomplete_keys"
        failed=1
      else
        printf '[PASS] Opaque API keys are backfilled for active projects\n'
      fi
    fi
  else
    local meta_status=$?
    if [[ "$meta_status" -eq 1 ]]; then
      printf '[FAIL] Metadata database missing: %s\n' "$META_DB"
    fi
    failed=1
  fi

  local compose_file="${PIGSTY_SUPABASE_DIR}/docker-compose.yml"
  if [[ -f "$compose_file" ]]; then
    if [[ ! -f "$PIGSTY_ENV_FILE" ]]; then
      printf '[FAIL] Pigsty Supabase environment is missing: %s\n' "$PIGSTY_ENV_FILE"
      failed=1
    else
      local configured_analytics_db configured_analytics_schema configured_analytics_url
      configured_analytics_db="$(supacloud_env_value "$PIGSTY_ENV_FILE" LOGFLARE_DB)"
      configured_analytics_schema="$(supacloud_env_value "$PIGSTY_ENV_FILE" LOGFLARE_SCHEMA)"
      configured_analytics_url="$(supacloud_env_value "$PIGSTY_ENV_FILE" LOGFLARE_DATABASE_URL)"
      if [[ "$configured_analytics_db" == "$ANALYTICS_DB" && "$configured_analytics_schema" == "$ANALYTICS_SCHEMA" ]]; then
        printf '[PASS] Pigsty Logflare environment targets %s.%s\n' "$ANALYTICS_DB" "$ANALYTICS_SCHEMA"
      else
        printf '[FAIL] Pigsty Logflare environment does not target %s.%s\n' "$ANALYTICS_DB" "$ANALYTICS_SCHEMA"
        failed=1
      fi
      if [[ -n "$configured_analytics_url" && "$configured_analytics_url" != */"$ANALYTICS_DB" && "$configured_analytics_url" != */"$ANALYTICS_DB"\?* ]]; then
        printf '[FAIL] LOGFLARE_DATABASE_URL does not target database %s\n' "$ANALYTICS_DB"
        failed=1
      fi
    fi
  fi

  local management_pgpassword_result
  management_pgpassword_result="$(check_management_pgpassword_alias)"
  if [[ "$management_pgpassword_result" == "compatible" ]]; then
    printf '[PASS] Management PGPASSWORD alias is compatible\n'
  elif [[ "$management_pgpassword_result" == "empty-alias" ]]; then
    printf '[FAIL] Management PGPASSWORD is empty while PG_PASSWORD is configured\n'
    failed=1
  elif [[ -n "$management_pgpassword_result" ]]; then
    printf '[FAIL] Management PGPASSWORD alias check failed: %s\n' "$management_pgpassword_result"
    failed=1
  fi

  local pgbouncer_auth_result
  pgbouncer_auth_result="$(check_pgbouncer_auth_file)"
  if [[ "$pgbouncer_auth_result" == "compatible" ]]; then
    printf '[PASS] PgBouncer auth file is structurally compatible\n'
  elif [[ "$pgbouncer_auth_result" == "not-present" ]]; then
    printf '[PASS] PgBouncer auth file is not present on this node\n'
  else
    printf '[FAIL] PgBouncer auth file is structurally broken\n'
    failed=1
  fi

  local monitor_connect_result
  monitor_connect_result="$(check_monitor_connect_compat)"
  if [[ "$monitor_connect_result" == "not-present" || "$monitor_connect_result" == "0" ]]; then
    printf '[PASS] Pigsty monitor database CONNECT compatibility\n'
  else
    printf '[FAIL] Pigsty monitor lacks CONNECT on %s database(s)\n' "$monitor_connect_result"
    failed=1
  fi
  return "$failed"
}

if [[ "$MODE" == "dry-run" ]]; then
  target_databases="$(list_target_databases | awk '!seen[$0]++')"
  printf 'Would ensure Analytics database/schema: %s.%s (owner %s)\n' "$ANALYTICS_DB" "$ANALYTICS_SCHEMA" "$ANALYTICS_OWNER"
  printf 'Would copy a non-empty legacy postgres.%s schema only when the destination is empty.\n' "$ANALYTICS_SCHEMA"
  printf 'Would stop the legacy Analytics container before copying data.\n'
  printf 'Would patch Pigsty environment: %s\n' "$PIGSTY_ENV_FILE"
  printf 'Would ensure Studio compatibility in databases:\n'
  printf '%s\n' "$target_databases" | sed 's/^/  - /'
  printf 'Would repair PostgREST pre-request compatibility in active tenant databases.\n'
  printf 'Would repair auth.uid/auth.jwt/auth.role for claims-only modern Session JWTs.\n'
  printf 'Would repair the Auth user delete fence without mutating rows before an allowed hard DELETE.\n'
  printf 'Would reconcile active tenant authenticator roles and their canonical passwords.\n'
  printf 'Would reconcile an empty PGPASSWORD alias from PG_PASSWORD without printing either value.\n'
  printf 'Would repair known Pigsty timing noise in the PgBouncer auth file and reject unknown corruption.\n'
  printf 'Would grant dbuser_monitor CONNECT on every connectable non-template database.\n'
  printf 'Would add opaque API key metadata columns in %s and run supacloud --init-db when available.\n' "$META_DB"
  exit 0
fi

if [[ "$MODE" == "prepare-analytics" ]]; then
  trap restore_analytics_after_prepare_failure EXIT
  apply_analytics_database
  migration_required=false
  env_was_target=false
  analytics_migration_required && migration_required=true
  pigsty_env_targets_analytics && env_was_target=true
  if [[ "$migration_required" == "true" || "$env_was_target" != "true" ]]; then
    stop_legacy_analytics
    if [[ "$ANALYTICS_WAS_RUNNING" == "true" ]]; then
      ANALYTICS_RECREATE_AFTER_PREPARE=true
    elif analytics_migration_marked && [[ "$env_was_target" != "true" && "$ANALYTICS_SERVICE_PRESENT" == "true" ]]; then
      # Recover a stopped managed container left by a prior marker-after-write failure.
      ANALYTICS_RECREATE_AFTER_PREPARE=true
    fi
  else
    recover_stopped_prepared_analytics
  fi
  migrate_legacy_analytics
  grant_analytics_owner_privileges
  patch_pigsty_env
  start_prepared_analytics
  ANALYTICS_PREPARE_COMPLETED=true
  printf '[PASS] Analytics is prepared for the Pigsty 4.4 Logflare stack.\n'
  exit 0
fi

if [[ "$MODE" == "apply" ]]; then
  apply_analytics_database
  if analytics_migration_required; then
    printf '[FAIL] Legacy Analytics data still needs an offline migration.\n' >&2
    printf '       Run --prepare-analytics before --apply so the writer is stopped and verified.\n' >&2
    exit 1
  fi
  migrate_legacy_analytics
  grant_analytics_owner_privileges
  patch_pigsty_env
  apply_metadata_columns
  reconcile_management_pgpassword_alias
  repair_pgbouncer_auth_file
  apply_monitor_connect_compat
  apply_tenant_authenticator_compat
  target_databases="$(list_target_databases | awk '!seen[$0]++')"
  while IFS= read -r database; do
    [[ -n "$database" ]] || continue
    apply_pg_stat_compat "$database"
    if [[ "$database" != "postgres" ]]; then
      apply_postgrest_prerequest_compat "$database"
      apply_auth_jwt_helpers_compat "$database"
      apply_auth_delete_fence_compat "$database"
    fi
  done <<< "$target_databases"

  if command -v supacloud >/dev/null 2>&1; then
    supacloud --init-db
  else
    printf '[WARN] supacloud binary not found; opaque keys will be encrypted/backfilled when the new management binary runs --init-db.\n' >&2
  fi
fi

check_all

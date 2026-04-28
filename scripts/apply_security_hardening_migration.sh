#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/supabase/management-api.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required in $ENV_FILE" >&2
  exit 1
fi

PSQL="${PSQL:-$(command -v psql)}"
if [[ -z "$PSQL" ]]; then
  echo "psql not found" >&2
  exit 1
fi

echo "[management] applying audit/encryption schema"
"$PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_ref VARCHAR(50),
  actor TEXT NOT NULL DEFAULT 'unknown',
  action TEXT NOT NULL,
  method VARCHAR(16) NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_project_created
  ON audit_logs(project_ref, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
  ON audit_logs(action, created_at DESC);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS db_password_encrypted TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS jwt_secret_encrypted TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS service_role_key_encrypted TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS s3_secret_key_encrypted TEXT;

ALTER TABLE project_secrets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
SQL

admin_user="$("$PSQL" "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "select current_user")"
tenant_base_url="${DATABASE_URL%/*}"

echo "[tenants] applying existing database isolation patch"
"$PSQL" "$DATABASE_URL" -AtF $'\t' -v ON_ERROR_STOP=1 -c \
  "SELECT ref, db_name, db_user FROM projects WHERE deleted_at IS NULL AND db_name IS NOT NULL AND db_user IS NOT NULL ORDER BY ref" |
while IFS=$'\t' read -r ref db_name db_user; do
  if [[ -z "$db_name" || -z "$db_user" ]]; then
    continue
  fi
  authenticator_role="authenticator_${ref}"

  db_name_literal="${db_name//\'/\'\'}"
  db_exists="$("$PSQL" "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_database WHERE datname = '${db_name_literal}'")"
  if [[ "$db_exists" != "1" ]]; then
    echo "[tenant:$db_name] skipped missing database"
    continue
  fi
  authenticator_literal="${authenticator_role//\'/\'\'}"
  authenticator_exists="$("$PSQL" "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_roles WHERE rolname = '${authenticator_literal}'")"

  echo "[tenant:$db_name] database grants"
  "$PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -v dbname="$db_name" \
    -v dbuser="$db_user" \
    -v adminuser="$admin_user" <<'SQL'
REVOKE CONNECT ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"dbname" TO :"dbuser";
GRANT CONNECT, TEMPORARY ON DATABASE :"dbname" TO supabase_auth_admin;
GRANT CONNECT, TEMPORARY ON DATABASE :"dbname" TO supabase_admin;
GRANT ALL PRIVILEGES ON DATABASE :"dbname" TO :"adminuser";
SQL

  if [[ -n "$authenticator_exists" ]]; then
    "$PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 \
      -v dbname="$db_name" \
      -v authenticator="$authenticator_role" <<'SQL'
GRANT CONNECT, TEMPORARY ON DATABASE :"dbname" TO :"authenticator";
SQL
  else
    echo "[tenant:$db_name] skipped authenticator grant; missing role $authenticator_role"
  fi

  echo "[tenant:$db_name] schema grants"
  "$PSQL" "${tenant_base_url}/${db_name}" -v ON_ERROR_STOP=1 -v dbuser="$db_user" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO :"dbuser";
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO :"dbuser";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"dbuser";
GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO :"dbuser";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO :"dbuser";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"dbuser";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON ROUTINES TO :"dbuser";

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO authenticated, service_role;
GRANT ALL ON SCHEMA public TO supabase_auth_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
SQL
done

echo "[verify] management schema"
"$PSQL" "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c \
  "SELECT to_regclass('public.audit_logs'), count(*) FROM information_schema.columns WHERE table_name = 'projects' AND column_name IN ('db_password_encrypted','jwt_secret_encrypted','service_role_key_encrypted','s3_secret_key_encrypted');"

echo "security hardening migration complete"

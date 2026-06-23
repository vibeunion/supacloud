#!/bin/bash
# SupaCloud - Database Management Script
# Usage: db_manager.sh <create|delete|status> <project_ref> [password]

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"
DB_PASSWORD="${3:-}"

# Get PostgreSQL connection info from environment variables or default values
PG_HOST="${PG_HOST:-${POSTGRES_HOST:-localhost}}"
PG_PORT="${PG_PORT:-${POSTGRES_PORT:-6432}}"
PG_USER="${PG_USER:-postgres}"
PG_DATABASE="${PG_DATABASE:-postgres}"

# Project naming convention
DB_NAME="supa_${PROJECT_REF}"
DB_USER="role_${PROJECT_REF}"

# Validate parameters
validate_params() {
    if [ -z "$ACTION" ] || [ -z "$PROJECT_REF" ]; then
        echo "ERROR: Missing required parameters" >&2
        echo "Usage: $0 <create|delete|status> <project_ref> [password]" >&2
        exit 1
    fi

    # Validate project_ref format (alphanumeric and hyphens, max 20 chars)
    if ! echo "$PROJECT_REF" | grep -qE '^[a-z0-9-]{1,20}$'; then
        echo "ERROR: Invalid project_ref format. Use lowercase alphanumeric and hyphens, max 20 chars." >&2
        exit 1
    fi
}

# Execute SQL command
run_sql() {
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -t -A -c "$1" 2>/dev/null
}

escape_sql_literal() {
    printf "%s" "$1" | sed "s/'/''/g"
}

# Disk space pre-check (prevent disk full causing WAL write failure leading to cluster crash)
check_disk_space() {
    local data_dir="${PG_DATA_DIR:-/var/lib/pgsql/data}"
    local min_gb="${MIN_DISK_GB:-10}"

    # Try to detect actual PostgreSQL data directory
    if [ ! -d "$data_dir" ]; then
        # Common path fallbacks
        for d in /pg/data /var/lib/postgresql/data /data/pgsql; do
            if [ -d "$d" ]; then
                data_dir="$d"
                break
            fi
        done
    fi

    if [ ! -d "$data_dir" ]; then
        echo "WARNING: Cannot determine PostgreSQL data directory, skipping disk check" >&2
        return 0
    fi

    local avail_kb
    avail_kb=$(df -k "$data_dir" 2>/dev/null | awk 'NR==2 {print $4}')
    local min_kb=$((min_gb * 1024 * 1024))

    if [ -n "$avail_kb" ] && [ "$avail_kb" -lt "$min_kb" ]; then
        echo "ERROR: Insufficient disk space on ${data_dir}" >&2
        echo "  Available: $((avail_kb / 1024))MB, Required minimum: ${min_gb}GB" >&2
        echo "  Refusing to create database to prevent WAL write failures and cluster crash." >&2
        exit 1
    fi

    echo "Disk check passed: $((avail_kb / 1024))MB available on ${data_dir}"
}

# Create project database and role
create_database() {
    if [ -z "$DB_PASSWORD" ]; then
        echo "ERROR: Password is required for create action" >&2
        exit 1
    fi

    echo "Creating database ${DB_NAME} and role ${DB_USER}..."

    # Disk space pre-check
    check_disk_space

    local escaped_db_password
    escaped_db_password=$(escape_sql_literal "$DB_PASSWORD")

    # Create role
    run_sql "DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
            EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '${DB_USER}', '${escaped_db_password}');
        ELSE
            EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', '${DB_USER}', '${escaped_db_password}');
        END IF;
    END
    \$\$;"

    # Create database
    if ! run_sql "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
        psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -c \
            "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" 2>/dev/null
    fi

    # Set permissions
    run_sql "REVOKE ALL ON DATABASE ${DB_NAME} FROM PUBLIC;"
    run_sql "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"

    # Install Supabase required extensions in project database
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB_NAME" <<'EXTENSIONS'
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pgjwt;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXTENSIONS

    # Initialize Supabase core Schema (auth, storage, realtime)
    echo "Initializing Supabase schema for ${DB_NAME}..."
    
    local auth_role="authenticator_${PROJECT_REF}"

    # First create authenticator role (needs variable substitution)
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB_NAME" <<EOF
-- Create tenant-specific authenticator role
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${auth_role}') THEN
        EXECUTE format('CREATE ROLE %I NOINHERIT LOGIN PASSWORD %L', '${auth_role}', '${escaped_db_password}');
    ELSE
        EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', '${auth_role}', '${escaped_db_password}');
    END IF;
END
\$\$;
EOF

    # Execute static Schema initialization
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB_NAME" <<'SUPABASE_SCHEMA'

-- ============================================================
-- Supabase Core Schema Initialization (Simplified)
-- Based on supabase/postgres official migrations
-- ============================================================

-- 1. Create Supabase specific Roles
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_admin') THEN
        CREATE ROLE supabase_admin NOLOGIN NOINHERIT BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        CREATE ROLE supabase_auth_admin NOLOGIN NOINHERIT CREATEROLE CREATEDB;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
        CREATE ROLE supabase_storage_admin NOLOGIN NOINHERIT;
    END IF;
END
$$;

-- Grant authenticator ability to switch to various roles
GRANT anon TO postgres;
GRANT authenticated TO postgres;
GRANT service_role TO postgres;
GRANT supabase_admin TO postgres;

-- 设置 supabase_auth_admin 默认 search_path (GoTrue 需要)
ALTER ROLE supabase_auth_admin SET search_path TO auth, public;

-- 2. Auth Schema
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
    instance_id UUID,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aud VARCHAR(255),
    role VARCHAR(255),
    email VARCHAR(255) UNIQUE,
    encrypted_password VARCHAR(255),
    email_confirmed_at TIMESTAMPTZ,
    invited_at TIMESTAMPTZ,
    confirmation_token VARCHAR(255),
    confirmation_sent_at TIMESTAMPTZ,
    recovery_token VARCHAR(255),
    recovery_sent_at TIMESTAMPTZ,
    email_change_token_new VARCHAR(255),
    email_change VARCHAR(255),
    email_change_sent_at TIMESTAMPTZ,
    last_sign_in_at TIMESTAMPTZ,
    raw_app_meta_data JSONB,
    raw_user_meta_data JSONB,
    is_super_admin BOOLEAN,
    phone VARCHAR(15) UNIQUE DEFAULT NULL,
    phone_confirmed_at TIMESTAMPTZ,
    phone_change VARCHAR(15) DEFAULT '',
    phone_change_token VARCHAR(255) DEFAULT '',
    phone_change_sent_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
    email_change_token_current VARCHAR(255) DEFAULT '',
    email_change_confirm_status SMALLINT DEFAULT 0,
    banned_until TIMESTAMPTZ,
    reauthentication_token VARCHAR(255) DEFAULT '',
    reauthentication_sent_at TIMESTAMPTZ,
    is_sso_user BOOLEAN NOT NULL DEFAULT false,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS users_instance_id_idx ON auth.users (instance_id);
CREATE INDEX IF NOT EXISTS users_email_idx ON auth.users (email);

COMMENT ON TABLE auth.users IS 'Auth: Stores user login data within a secure schema.';

CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
    instance_id UUID,
    id BIGSERIAL PRIMARY KEY,
    token VARCHAR(255),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    revoked BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    parent VARCHAR(255),
    session_id UUID
);
CREATE INDEX IF NOT EXISTS refresh_tokens_token_idx ON auth.refresh_tokens (token);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON auth.refresh_tokens (user_id);

CREATE TABLE IF NOT EXISTS auth.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    factor_id UUID,
    aal VARCHAR(10),
    not_after TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON auth.sessions (user_id);

CREATE TABLE IF NOT EXISTS auth.identities (
    id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    identity_data JSONB NOT NULL,
    provider TEXT NOT NULL,
    last_sign_in_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    email TEXT GENERATED ALWAYS AS (lower(identity_data->>'email')) STORED,
    CONSTRAINT identities_pkey PRIMARY KEY (provider, id)
);
CREATE INDEX IF NOT EXISTS identities_user_id_idx ON auth.identities (user_id);
CREATE INDEX IF NOT EXISTS identities_email_idx ON auth.identities (email);

-- Grants
GRANT ALL ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO supabase_auth_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA auth TO service_role;

-- 3. Storage Schema
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_storage_admin;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS storage.buckets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    owner UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    public BOOLEAN DEFAULT false,
    avif_autodetection BOOLEAN DEFAULT false,
    file_size_limit BIGINT,
    allowed_mime_types TEXT[],
    owner_id TEXT
);

CREATE TABLE IF NOT EXISTS storage.objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id TEXT REFERENCES storage.buckets(id),
    name TEXT,
    owner UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB,
    path_tokens TEXT[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
    version TEXT,
    owner_id TEXT
);
CREATE INDEX IF NOT EXISTS objects_bucket_id_idx ON storage.objects (bucket_id);
CREATE UNIQUE INDEX IF NOT EXISTS objects_bucket_name_idx ON storage.objects (bucket_id, name);

-- Grants
GRANT ALL ON ALL TABLES IN SCHEMA storage TO supabase_storage_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO supabase_storage_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA storage TO anon, authenticated;

-- Enable RLS
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 4. Realtime Schema
CREATE SCHEMA IF NOT EXISTS realtime;
GRANT USAGE ON SCHEMA realtime TO anon, authenticated, service_role;

-- 5. Public Schema permissions
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- New public tables are not exposed through the Data API by default.
-- Tenants must add explicit GRANT statements for each table they want to expose.

-- 6. Grant authenticator ability to switch to API roles
GRANT anon, authenticated, service_role TO authenticator_${PROJECT_REF};

SUPABASE_SCHEMA

    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -c \
        "GRANT CONNECT ON DATABASE ${DB_NAME} TO authenticator_${PROJECT_REF};" 2>/dev/null || true

    # service_role needs to bypass RLS to write data directly in Edge Function management operations
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB_NAME" -c \
        "ALTER ROLE service_role BYPASSRLS;" 2>/dev/null || true

    # Configure default RLS on public schema: enable, but don't add policies yet
    # Here only set default_row_security = on, prevent tables without policies from being exposed
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB_NAME" -c \
        "SET row_security = on;" 2>/dev/null || true

    echo "Database ${DB_NAME} created successfully"
}

# Delete project database and role
delete_database() {
    echo "Deleting database ${DB_NAME} and role ${DB_USER}..."

    # Terminate active connections
    run_sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" || true

    # Delete database
    if run_sql "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
        psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -c \
            "DROP DATABASE ${DB_NAME};" 2>/dev/null
    fi

    # Delete role
    if run_sql "SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}'" | grep -q 1; then
        run_sql "DROP ROLE ${DB_USER};"
    fi

    echo "Database ${DB_NAME} deleted successfully"
}

# Check database status
check_status() {
    local db_exists
    db_exists=$(run_sql "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" || echo "")

    if [ "$db_exists" = "1" ]; then
        local size
        size=$(run_sql "SELECT pg_size_pretty(pg_database_size('${DB_NAME}'))")
        local connections
        connections=$(run_sql "SELECT count(*) FROM pg_stat_activity WHERE datname = '${DB_NAME}'")
        echo "STATUS=active"
        echo "DB_SIZE=${size}"
        echo "CONNECTIONS=${connections}"
    else
        echo "STATUS=not_found"
    fi
}

# Main logic
validate_params

case "$ACTION" in
    create)
        create_database
        ;;
    delete)
        delete_database
        ;;
    status)
        check_status
        ;;
    *)
        echo "ERROR: Unknown action '${ACTION}'. Use: create, delete, status" >&2
        exit 1
        ;;
esac

#!/bin/bash
# SupaCloud - 数据库管理脚本
# 用法: db_manager.sh <create|delete|status> <project_ref> [password]

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"
DB_PASSWORD="${3:-}"

# 从环境变量或默认值获取 PostgreSQL 连接信息
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-postgres}"
PG_DATABASE="${PG_DATABASE:-postgres}"

# 项目命名规范
DB_NAME="supa_${PROJECT_REF}"
DB_USER="role_${PROJECT_REF}"

# 验证参数
validate_params() {
    if [ -z "$ACTION" ] || [ -z "$PROJECT_REF" ]; then
        echo "ERROR: Missing required parameters" >&2
        echo "Usage: $0 <create|delete|status> <project_ref> [password]" >&2
        exit 1
    fi

    # 验证 project_ref 格式 (字母数字, 最长20字符)
    if ! echo "$PROJECT_REF" | grep -qE '^[a-z0-9]{1,20}$'; then
        echo "ERROR: Invalid project_ref format. Use lowercase alphanumeric, max 20 chars." >&2
        exit 1
    fi
}

# 执行 SQL 命令
run_sql() {
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -t -A -c "$1" 2>/dev/null
}

# 磁盘空间预检（防止磁盘满导致 WAL 写入失败引发集群崩溃）
check_disk_space() {
    local data_dir="${PG_DATA_DIR:-/var/lib/pgsql/data}"
    local min_gb="${MIN_DISK_GB:-10}"

    # 尝试检测实际 PostgreSQL 数据目录
    if [ ! -d "$data_dir" ]; then
        # 常见路径回退
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

# 创建项目数据库和角色
create_database() {
    if [ -z "$DB_PASSWORD" ]; then
        echo "ERROR: Password is required for create action" >&2
        exit 1
    fi

    echo "Creating database ${DB_NAME} and role ${DB_USER}..."

    # 磁盘空间预检
    check_disk_space

    # 创建角色
    run_sql "DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
            CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
        END IF;
    END
    \$\$;"

    # 创建数据库
    if ! run_sql "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
        psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -c \
            "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" 2>/dev/null
    fi

    # 设置权限
    run_sql "REVOKE ALL ON DATABASE ${DB_NAME} FROM PUBLIC;"
    run_sql "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"

    # 在项目数据库中安装 Supabase 必需的扩展
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB_NAME" <<'EXTENSIONS'
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pgjwt;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXTENSIONS

    # 初始化 Supabase 核心 Schema (auth, storage, realtime)
    echo "Initializing Supabase schema for ${DB_NAME}..."
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB_NAME" <<'SUPABASE_SCHEMA'

-- ============================================================
-- Supabase Core Schema Initialization (Simplified)
-- Based on supabase/postgres official migrations
-- ============================================================

-- 1. 创建 Supabase 专用 Role
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

-- 授予 authenticator 可以切换到各角色
GRANT anon TO postgres;
GRANT authenticated TO postgres;
GRANT service_role TO postgres;
GRANT supabase_admin TO postgres;

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

-- 授权
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

-- 授权
GRANT ALL ON ALL TABLES IN SCHEMA storage TO supabase_storage_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO supabase_storage_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA storage TO anon, authenticated;

-- 启用 RLS
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 4. Realtime Schema
CREATE SCHEMA IF NOT EXISTS realtime;
GRANT USAGE ON SCHEMA realtime TO anon, authenticated, service_role;

-- 5. Public Schema 权限
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;

-- 6. authenticator 角色权限（PostgREST 通过此角色连接数据库）
DO $$
BEGIN
    -- 创建 authenticator 角色（如果不存在）
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
        CREATE ROLE authenticator NOINHERIT LOGIN;
    END IF;
    -- 授权 authenticator 可切换到 API 角色
    GRANT anon, authenticated, service_role TO authenticator;
END
$$;

SUPABASE_SCHEMA

    # 在库级别授予 authenticator CONNECT 权限
    # 注意：GRANT ON DATABASE 必须在 psql 连接到 postgres 库时执行
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -c \
        "GRANT CONNECT ON DATABASE ${DB_NAME} TO authenticator;" 2>/dev/null || true

    echo "Database ${DB_NAME} created successfully"
}

# 删除项目数据库和角色
delete_database() {
    echo "Deleting database ${DB_NAME} and role ${DB_USER}..."

    # 终止活动连接
    run_sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" || true

    # 删除数据库
    if run_sql "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
        psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -c \
            "DROP DATABASE ${DB_NAME};" 2>/dev/null
    fi

    # 删除角色
    if run_sql "SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}'" | grep -q 1; then
        run_sql "DROP ROLE ${DB_USER};"
    fi

    echo "Database ${DB_NAME} deleted successfully"
}

# 检查数据库状态
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

# 主逻辑
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

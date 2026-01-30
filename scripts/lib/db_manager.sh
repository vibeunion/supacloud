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

# 创建项目数据库和角色
create_database() {
    if [ -z "$DB_PASSWORD" ]; then
        echo "ERROR: Password is required for create action" >&2
        exit 1
    fi

    echo "Creating database ${DB_NAME} and role ${DB_USER}..."

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

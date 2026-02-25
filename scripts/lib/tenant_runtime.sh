#!/bin/bash
# SupaCloud - 租户运行时管理脚本
# 为每个租户动态启动独立的 PostgREST 进程，绑定到唯一端口，连接专属租户库
# 用法: tenant_runtime.sh <start|stop|restart|status|port> <project_ref>

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"

# 配置
TENANT_CONFIG_DIR="${TENANT_CONFIG_DIR:-/etc/supabase/tenants}"
POSTGREST_BIN="${POSTGREST_BIN:-/usr/local/bin/postgrest}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PORT_BASE="${PORT_BASE:-3100}"
PORT_RANGE="${PORT_RANGE:-10000}"
SUPACLOUD_META_DB="${SUPACLOUD_META_DB:-supacloud_meta}"

# 验证参数
validate_params() {
    if [ -z "$ACTION" ] || [ -z "$PROJECT_REF" ]; then
        echo "ERROR: Missing required parameters" >&2
        echo "Usage: $0 <start|stop|restart|status|port> <project_ref>" >&2
        exit 1
    fi
}

# ========== 端口分配（确定性 hash，避免冲突） ==========
get_tenant_port() {
    local ref="$1"
    local hash
    hash=$(echo -n "$ref" | cksum | awk '{print $1}')
    local port=$(( PORT_BASE + (hash % PORT_RANGE) ))

    # 冲突检测：如果端口被其他租户占用，线性探测
    local config_dir="$TENANT_CONFIG_DIR"
    local max_tries=100
    local try=0
    while [ $try -lt $max_tries ]; do
        local conflict=false
        if [ -d "$config_dir" ]; then
            for f in "$config_dir"/*.env; do
                [ -f "$f" ] || continue
                local existing_ref
                existing_ref=$(basename "$f" .env)
                [ "$existing_ref" = "$ref" ] && continue
                if grep -q "PGRST_SERVER_PORT=${port}" "$f" 2>/dev/null; then
                    conflict=true
                    break
                fi
            done
        fi
        if [ "$conflict" = false ]; then
            echo "$port"
            return
        fi
        port=$(( port + 1 ))
        try=$(( try + 1 ))
    done

    echo "ERROR: Cannot find available port for ${ref}" >&2
    exit 1
}

# ========== 从 supacloud_meta 查询租户凭据 ==========
get_tenant_credentials() {
    local ref="$1"
    local field="$2"

    psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -d "$SUPACLOUD_META_DB" \
        -t -A -c "SELECT ${field} FROM projects WHERE ref='${ref}'" 2>/dev/null
}

# ========== 确保 PostgREST 二进制可用 ==========
ensure_postgrest() {
    if command -v postgrest &>/dev/null; then
        POSTGREST_BIN=$(command -v postgrest)
        return
    fi

    if [ -x "$POSTGREST_BIN" ]; then
        return
    fi

    echo "PostgREST binary not found. Installing..."

    # 从容器中提取（如果 Supabase 容器正在运行）
    local container_id
    container_id=$(docker ps -q -f "name=supabase-rest" 2>/dev/null || true)
    if [ -n "$container_id" ]; then
        echo "Extracting PostgREST from running container..."
        docker cp "${container_id}:/usr/local/bin/postgrest" "$POSTGREST_BIN" 2>/dev/null || true
        if [ -x "$POSTGREST_BIN" ]; then
            echo "PostgREST extracted successfully"
            return
        fi
    fi

    # 直接下载
    local arch
    arch=$(uname -m)
    case "$arch" in
        x86_64) arch="linux-static-x64" ;;
        aarch64) arch="linux-static-aarch64" ;;
        *) echo "ERROR: Unsupported architecture: $arch" >&2; exit 1 ;;
    esac

    local version="v12.2.3"
    local url="https://github.com/PostgREST/postgrest/releases/download/${version}/postgrest-${version}-${arch}.tar.xz"
    echo "Downloading PostgREST ${version}..."

    local tmp_dir
    tmp_dir=$(mktemp -d)
    if curl -fsSL "https://gh-proxy.net/${url}" -o "${tmp_dir}/postgrest.tar.xz" 2>/dev/null || \
       curl -fsSL "${url}" -o "${tmp_dir}/postgrest.tar.xz"; then
        tar -xf "${tmp_dir}/postgrest.tar.xz" -C "${tmp_dir}"
        mv "${tmp_dir}/postgrest" "$POSTGREST_BIN"
        chmod +x "$POSTGREST_BIN"
        echo "PostgREST installed to $POSTGREST_BIN"
    else
        echo "ERROR: Failed to download PostgREST" >&2
        rm -rf "$tmp_dir"
        exit 1
    fi
    rm -rf "$tmp_dir"
}

# ========== 生成租户配置文件 ==========
generate_tenant_config() {
    local ref="$1"
    local port="$2"

    mkdir -p "$TENANT_CONFIG_DIR"

    # 查询租户凭据
    local db_name="supa_${ref}"
    local db_password
    db_password=$(get_tenant_credentials "$ref" "db_password")
    local jwt_secret
    jwt_secret=$(get_tenant_credentials "$ref" "jwt_secret")

    if [ -z "$db_password" ] || [ -z "$jwt_secret" ]; then
        echo "ERROR: Cannot find credentials for project ${ref} in supacloud_meta" >&2
        exit 1
    fi

    # 生成 .env 文件（systemd EnvironmentFile）
    cat > "${TENANT_CONFIG_DIR}/${ref}.env" <<EOF
# SupaCloud Tenant Runtime: ${ref}
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
PGRST_DB_URI=postgres://authenticator:${db_password}@${PG_HOST}:${PG_PORT}/${db_name}
PGRST_DB_SCHEMAS=public,storage,graphql_public
PGRST_DB_ANON_ROLE=anon
PGRST_JWT_SECRET=${jwt_secret}
PGRST_SERVER_PORT=${port}
PGRST_DB_POOL=10
PGRST_DB_POOL_ACQUISITION_TIMEOUT=10
PGRST_LOG_LEVEL=warn
EOF
    chmod 600 "${TENANT_CONFIG_DIR}/${ref}.env"

    # 生成 PostgREST 配置文件
    cat > "${TENANT_CONFIG_DIR}/${ref}.conf" <<EOF
# PostgREST config for tenant: ${ref}
db-uri = "postgres://authenticator:${db_password}@${PG_HOST}:${PG_PORT}/${db_name}"
db-schemas = "public, storage, graphql_public"
db-anon-role = "anon"
jwt-secret = "${jwt_secret}"
server-port = ${port}
db-pool = 10
db-pool-acquisition-timeout = 10
log-level = "warn"
EOF
    chmod 600 "${TENANT_CONFIG_DIR}/${ref}.conf"

    echo "Config generated for ${ref} on port ${port}"
}

# ========== 安装 systemd template unit ==========
install_systemd_template() {
    local unit_file="/etc/systemd/system/supacloud-pgrst@.service"
    if [ -f "$unit_file" ]; then
        return
    fi

    cat > "$unit_file" <<EOF
[Unit]
Description=SupaCloud PostgREST for tenant %i
After=postgresql.service network.target
Wants=network.target

[Service]
Type=simple
User=nobody
Group=nobody
EnvironmentFile=/etc/supabase/tenants/%i.env
ExecStart=${POSTGREST_BIN} /etc/supabase/tenants/%i.conf
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/supabase/tenants

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    echo "systemd template unit installed"
}

# ========== 启动租户运行时 ==========
start_runtime() {
    local ref="$1"

    ensure_postgrest
    install_systemd_template

    local port
    port=$(get_tenant_port "$ref")

    # 生成配置
    generate_tenant_config "$ref" "$port"

    # 启动 systemd 服务
    systemctl enable "supacloud-pgrst@${ref}" 2>/dev/null || true
    systemctl start "supacloud-pgrst@${ref}"

    # 等待健康检查
    echo "Waiting for PostgREST on port ${port}..."
    local retries=15
    while [ $retries -gt 0 ]; do
        if curl -sf "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
            echo "RUNTIME_STARTED=true"
            echo "PORT=${port}"
            echo "STATUS=running"
            return
        fi
        sleep 1
        retries=$((retries - 1))
    done

    echo "WARNING: PostgREST health check timeout, but service may still be starting" >&2
    echo "RUNTIME_STARTED=true"
    echo "PORT=${port}"
    echo "STATUS=starting"
}

# ========== 停止租户运行时 ==========
stop_runtime() {
    local ref="$1"

    systemctl stop "supacloud-pgrst@${ref}" 2>/dev/null || true
    systemctl disable "supacloud-pgrst@${ref}" 2>/dev/null || true

    # 清理配置文件
    rm -f "${TENANT_CONFIG_DIR}/${ref}.env" "${TENANT_CONFIG_DIR}/${ref}.conf"

    echo "Runtime stopped for ${ref}"
}

# ========== 重启租户运行时 ==========
restart_runtime() {
    local ref="$1"

    if systemctl is-active "supacloud-pgrst@${ref}" >/dev/null 2>&1; then
        # 重新生成配置（凭据可能已更新）
        local port
        port=$(get_tenant_port "$ref")
        generate_tenant_config "$ref" "$port"
        systemctl restart "supacloud-pgrst@${ref}"
        echo "Runtime restarted for ${ref} on port ${port}"
    else
        # 未运行则启动
        start_runtime "$ref"
    fi
}

# ========== 查询状态 ==========
check_status() {
    local ref="$1"

    if systemctl is-active "supacloud-pgrst@${ref}" >/dev/null 2>&1; then
        local port
        port=$(get_tenant_port "$ref")
        local health="unknown"
        if curl -sf "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
            health="healthy"
        else
            health="unhealthy"
        fi
        echo "STATUS=running"
        echo "PORT=${port}"
        echo "HEALTH=${health}"
    else
        echo "STATUS=stopped"
    fi
}

# ========== 获取端口 ==========
get_port() {
    local ref="$1"
    local port
    port=$(get_tenant_port "$ref")
    echo "$port"
}

# 主逻辑
validate_params

case "$ACTION" in
    start)
        start_runtime "$PROJECT_REF"
        ;;
    stop)
        stop_runtime "$PROJECT_REF"
        ;;
    restart)
        restart_runtime "$PROJECT_REF"
        ;;
    status)
        check_status "$PROJECT_REF"
        ;;
    port)
        get_port "$PROJECT_REF"
        ;;
    *)
        echo "ERROR: Unknown action '${ACTION}'. Use: start, stop, restart, status, port" >&2
        exit 1
        ;;
esac

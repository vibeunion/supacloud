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
GOTRUE_BIN="${GOTRUE_BIN:-/usr/local/bin/gotrue}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PGRST_PORT_BASE="${PGRST_PORT_BASE:-3100}"
GOTRUE_PORT_BASE="${GOTRUE_PORT_BASE:-4100}"
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
    local type="$2" # pgrst 或 gotrue
    local base_port

    if [ "$type" = "pgrst" ]; then
        base_port=$PGRST_PORT_BASE
    elif [ "$type" = "gotrue" ]; then
        base_port=$GOTRUE_PORT_BASE
    else
        echo "ERROR: Unknown port type $type" >&2
        exit 1
    fi

    local hash
    hash=$(echo -n "$ref" | cksum | awk '{print $1}')
    local port=$(( base_port + (hash % PORT_RANGE) ))

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
                # 支持 ref.env (pgrst) 和 ref_gotrue.env (gotrue)
                existing_ref=$(basename "$f" | sed -e 's/\.env$//' -e 's/_gotrue$//')
                [ "$existing_ref" = "$ref" ] && continue
                
                local search_str="PGRST_SERVER_PORT=${port}"
                [ "$type" = "gotrue" ] && search_str="GOTRUE_API_PORT=${port}"

                if grep -q "$search_str" "$f" 2>/dev/null; then
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

    echo "ERROR: Cannot find available port for ${ref} (${type})" >&2
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

# ========== 确保 GoTrue 二进制可用 ==========
ensure_gotrue() {
    if command -v gotrue &>/dev/null; then
        GOTRUE_BIN=$(command -v gotrue)
        return
    fi

    if [ -x "$GOTRUE_BIN" ]; then
        return
    fi

    echo "GoTrue binary not found. Installing..."

    # 从容器中提取（如果 Supabase 容器正在运行）
    local container_id
    container_id=$(docker ps -q -f "name=supabase-auth" 2>/dev/null || podman ps -q -f "name=supabase-auth" 2>/dev/null || true)
    if [ -n "$container_id" ]; then
        echo "Extracting GoTrue from running container..."
        local tmp_bin="/tmp/gotrue-extract"
        # Bug Fix: 新版本的 supabase/gotrue 容器内二进制文件被重命名为 'auth'，需要同时尝试 gotrue 和 auth 两个名字
        (docker cp "${container_id}:/usr/local/bin/gotrue" "$tmp_bin" 2>/dev/null || \
         docker cp "${container_id}:/usr/local/bin/auth" "$tmp_bin" 2>/dev/null || \
         podman cp "${container_id}:/usr/local/bin/gotrue" "$tmp_bin" 2>/dev/null || \
         podman cp "${container_id}:/usr/local/bin/auth" "$tmp_bin" 2>/dev/null || true)
        if [ -x "$tmp_bin" ]; then
            mv "$tmp_bin" "$GOTRUE_BIN"
            echo "GoTrue extracted successfully"
            return
        fi
    fi
    
    echo "ERROR: Failed to extract GoTrue from container. Please ensure supabase-auth container is running, or download and place 'gotrue' binary at $GOTRUE_BIN manually." >&2
    exit 1
}

# ========== 生成租户配置文件 ==========
generate_tenant_config() {
    local ref="$1"
    local pgrst_port="$2"
    local gotrue_port="$3"

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

    # 查询租户的 API 外部访问 URL（用于 GoTrue API_EXTERNAL_URL）
    # 优先级：环境变量覆盖 > supacloud_meta.projects.api_url > 默认占位值
    local api_external_url="${GOTRUE_API_EXTERNAL_URL:-}"
    if [ -z "$api_external_url" ]; then
        api_external_url=$(get_tenant_credentials "$ref" "api_url" 2>/dev/null || true)
    fi
    if [ -z "$api_external_url" ]; then
        api_external_url="https://your-supacloud-domain.com"
        echo "WARNING: API_EXTERNAL_URL not set. Set GOTRUE_API_EXTERNAL_URL env var or add api_url to supacloud_meta.projects" >&2
    fi

    # 1. 生成 PostgREST .env 和 .conf
    cat > "${TENANT_CONFIG_DIR}/${ref}.env" <<EOF
# SupaCloud Tenant PostgREST Runtime: ${ref}
PGRST_DB_URI=postgres://authenticator:${db_password}@${PG_HOST}:${PG_PORT}/${db_name}
PGRST_DB_SCHEMAS=public,storage,graphql_public
PGRST_DB_ANON_ROLE=anon
PGRST_JWT_SECRET=${jwt_secret}
PGRST_SERVER_PORT=${pgrst_port}
PGRST_DB_POOL=10
PGRST_DB_POOL_ACQUISITION_TIMEOUT=10
PGRST_LOG_LEVEL=warn
EOF
    chmod 644 "${TENANT_CONFIG_DIR}/${ref}.env"

    cat > "${TENANT_CONFIG_DIR}/${ref}.conf" <<EOF
# PostgREST config for tenant: ${ref}
db-uri = "postgres://authenticator:${db_password}@${PG_HOST}:${PG_PORT}/${db_name}"
db-schemas = "public, storage, graphql_public"
# Bug Fix: 多租户隔离 - 额外搜索路径应包含租户特定的 schema
db-extra-search-path = "public, extensions, auth, ${ref}"
db-anon-role = "anon"
jwt-secret = "${jwt_secret}"
server-port = ${pgrst_port}
# Bug Fix: 绑定到 0.0.0.0 以允许 Kong 容器（podman/docker 网络）通过宿主机桥接 IP 访问
server-host = "0.0.0.0"
db-pool = 10
db-pool-acquisition-timeout = 10
log-level = "warn"
EOF
    chmod 644 "${TENANT_CONFIG_DIR}/${ref}.conf"

    # 2. 生成 GoTrue .env
    # 获取租户配置的邮件发件人（如果有）
    local gotrue_sender="${GOTRUE_SMTP_ADMIN_EMAIL:-noreply@${api_external_url#https://}}"
    local smtp_host="${GOTRUE_SMTP_HOST:-}"
    local smtp_user="${GOTRUE_SMTP_USER:-}"
    local smtp_pass="${GOTRUE_SMTP_PASS:-}"
    
    cat > "${TENANT_CONFIG_DIR}/${ref}_gotrue.env" <<EOF
# SupaCloud Tenant GoTrue Runtime: ${ref}
# Bug Fix: 绑定到 0.0.0.0 以允许 Kong 容器通过宿主机桥接 IP 访问
GOTRUE_API_HOST=0.0.0.0
GOTRUE_API_PORT=${gotrue_port}
# Required: external URL used for email verification links and OAuth redirects
API_EXTERNAL_URL=${api_external_url}
# Bug Fix: SITE_URL 应该是实际可访问的 URL
GOTRUE_SITE_URL=${api_external_url}
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${db_password}@${PG_HOST}:${PG_PORT}/${db_name}
GOTRUE_JWT_SECRET=${jwt_secret}
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
# Bug Fix: 必须设置 JWT_AUD，否则用户查询会因 aud 为空而被过滤
GOTRUE_JWT_AUD=authenticated
GOTRUE_LOG_LEVEL=info
GOTRUE_SERVER_READ_TIMEOUT=20
GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION=true
EOF

    # 如果配置了 SMTP，添加到 GoTrue 配置
    if [ -n "$smtp_host" ]; then
        cat >> "${TENANT_CONFIG_DIR}/${ref}_gotrue.env" <<EOF
# SMTP Configuration
GOTRUE_SMTP_ADMIN_EMAIL=${gotrue_sender}
GOTRUE_SMTP_HOST=${smtp_host}
GOTRUE_SMTP_PORT=587
GOTRUE_SMTP_USER=${smtp_user}
GOTRUE_SMTP_PASS=${smtp_pass}
GOTRUE_SMTP_SENDER_NAME=SupaCloud
EOF
    fi
    chmod 644 "${TENANT_CONFIG_DIR}/${ref}_gotrue.env"

    echo "Config generated for ${ref} (pgrst_port=${pgrst_port}, gotrue_port=${gotrue_port})"
}

# ========== 安装 systemd template unit ==========
install_systemd_template() {
    local pgrst_unit="/etc/systemd/system/supacloud-pgrst@.service"
    if [ ! -f "$pgrst_unit" ]; then
        cat > "$pgrst_unit" <<EOF
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
    fi

    local gotrue_unit="/etc/systemd/system/supacloud-gotrue@.service"
    if [ ! -f "$gotrue_unit" ]; then
        cat > "$gotrue_unit" <<EOF
[Unit]
Description=SupaCloud GoTrue for tenant %i
After=postgresql.service network.target
Wants=network.target

[Service]
Type=simple
User=nobody
Group=nobody
EnvironmentFile=/etc/supabase/tenants/%i_gotrue.env
ExecStart=${GOTRUE_BIN}
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
    fi

    systemctl daemon-reload
    echo "systemd template units installed"
}

# ========== 启动租户运行时 ==========
start_runtime() {
    local ref="$1"

    ensure_postgrest
    ensure_gotrue
    install_systemd_template

    local pgrst_port
    pgrst_port=$(get_tenant_port "$ref" "pgrst")
    local gotrue_port
    gotrue_port=$(get_tenant_port "$ref" "gotrue")

    # 生成配置
    generate_tenant_config "$ref" "$pgrst_port" "$gotrue_port"

    # 启动 systemd 服务
    systemctl enable "supacloud-pgrst@${ref}" 2>/dev/null || true
    systemctl start "supacloud-pgrst@${ref}"
    
    systemctl enable "supacloud-gotrue@${ref}" 2>/dev/null || true
    systemctl start "supacloud-gotrue@${ref}"

    # 等待健康检查 (检查两个端口)
    echo "Waiting for PostgREST(${pgrst_port}) and GoTrue(${gotrue_port})..."
    local retries=20
    local pgrst_ok=0
    local gotrue_ok=0
    
    while [ $retries -gt 0 ]; do
        if [ $pgrst_ok -eq 0 ] && curl -sf "http://127.0.0.1:${pgrst_port}/" >/dev/null 2>&1; then
            pgrst_ok=1
        fi
        if [ $gotrue_ok -eq 0 ] && curl -sf "http://127.0.0.1:${gotrue_port}/health" >/dev/null 2>&1; then
            gotrue_ok=1
        fi
        
        if [ $pgrst_ok -eq 1 ] && [ $gotrue_ok -eq 1 ]; then
            echo "RUNTIME_STARTED=true"
            echo "PORT=${pgrst_port}"
            echo "GOTRUE_PORT=${gotrue_port}"
            echo "STATUS=running"
            return
        fi
        sleep 1
        retries=$((retries - 1))
    done

    echo "WARNING: Health check timeout, some services may still be starting" >&2
    echo "RUNTIME_STARTED=true"
    echo "PORT=${pgrst_port}"
    echo "GOTRUE_PORT=${gotrue_port}"
    echo "STATUS=starting"
}

# ========== 停止租户运行时 ==========
stop_runtime() {
    local ref="$1"

    systemctl stop "supacloud-pgrst@${ref}" 2>/dev/null || true
    systemctl disable "supacloud-pgrst@${ref}" 2>/dev/null || true
    
    systemctl stop "supacloud-gotrue@${ref}" 2>/dev/null || true
    systemctl disable "supacloud-gotrue@${ref}" 2>/dev/null || true

    # 清理配置文件
    rm -f "${TENANT_CONFIG_DIR}/${ref}.env" "${TENANT_CONFIG_DIR}/${ref}.conf" "${TENANT_CONFIG_DIR}/${ref}_gotrue.env"

    echo "Runtime stopped for ${ref}"
}

# ========== 重启租户运行时 ==========
restart_runtime() {
    local ref="$1"

    if systemctl is-active "supacloud-pgrst@${ref}" >/dev/null 2>&1 || systemctl is-active "supacloud-gotrue@${ref}" >/dev/null 2>&1; then
        # Bug Fix: 重启前同样需要确保二进制和 systemd 模板存在，防止如果宇机未分配 .service 直接崩溃
        ensure_postgrest
        ensure_gotrue
        install_systemd_template

        # 重新生成配置（凭据可能已更新）
        local pgrst_port
        pgrst_port=$(get_tenant_port "$ref" "pgrst")
        local gotrue_port
        gotrue_port=$(get_tenant_port "$ref" "gotrue")
        
        generate_tenant_config "$ref" "$pgrst_port" "$gotrue_port"
        
        systemctl restart "supacloud-pgrst@${ref}"
        systemctl restart "supacloud-gotrue@${ref}"
        echo "Runtime restarted for ${ref} (pgrst=${pgrst_port}, gotrue=${gotrue_port})"
    else
        # 未运行则启动
        start_runtime "$ref"
    fi
}

# ========== 查询状态 ==========
check_status() {
    local ref="$1"

    local pgrst_running=false
    local gotrue_running=false
    
    systemctl is-active "supacloud-pgrst@${ref}" >/dev/null 2>&1 && pgrst_running=true
    systemctl is-active "supacloud-gotrue@${ref}" >/dev/null 2>&1 && gotrue_running=true

    if [ "$pgrst_running" = true ] || [ "$gotrue_running" = true ]; then
        local pgrst_port
        pgrst_port=$(get_tenant_port "$ref" "pgrst")
        local gotrue_port
        gotrue_port=$(get_tenant_port "$ref" "gotrue")
        
        local health="unhealthy"
        if curl -sf "http://127.0.0.1:${pgrst_port}/" >/dev/null 2>&1 && curl -sf "http://127.0.0.1:${gotrue_port}/health" >/dev/null 2>&1; then
            health="healthy"
        elif curl -sf "http://127.0.0.1:${pgrst_port}/" >/dev/null 2>&1 || curl -sf "http://127.0.0.1:${gotrue_port}/health" >/dev/null 2>&1; then
            health="degraded"
        fi
        
        echo "STATUS=running"
        echo "PORT=${pgrst_port}"
        echo "GOTRUE_PORT=${gotrue_port}"
        echo "HEALTH=${health}"
    else
        echo "STATUS=stopped"
    fi
}

# ========== 获取端口 ==========
get_port() {
    local ref="$1"
    local pgrst_port
    pgrst_port=$(get_tenant_port "$ref" "pgrst")
    local gotrue_port
    gotrue_port=$(get_tenant_port "$ref" "gotrue")
    echo "PORT=${pgrst_port}"
    echo "GOTRUE_PORT=${gotrue_port}"
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

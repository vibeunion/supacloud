#!/bin/bash
# SupaCloud - Kong Gateway 管理脚本
# 用法: gateway_manager.sh <action> <project_ref> [args...]

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"
KONG_ADMIN_URL="${KONG_ADMIN_URL:-http://localhost:8001}"

# 验证参数
validate_params() {
    if [ -z "$ACTION" ] || [ -z "$PROJECT_REF" ]; then
        echo "ERROR: Missing required parameters" >&2
        echo "Usage: $0 <action> <project_ref> [args...]" >&2
        exit 1
    fi
}

# 确保 Consumer 存在
ensure_consumer() {
    curl -s -X POST "${KONG_ADMIN_URL}/consumers" \
        -d "username=${PROJECT_REF}" \
        -d "custom_id=${PROJECT_REF}" > /dev/null
}

# 设置 JWT 凭据
setup_jwt() {
    local jwt_secret="$1"
    ensure_consumer
    
    # 先尝试删除旧的 JWT 凭据（如果存在）
    local existing_id
    existing_id=$(curl -s "${KONG_ADMIN_URL}/consumers/${PROJECT_REF}/jwt" | grep -oP '"id":"\K[^"]+' | head -1 || true)
    if [ -n "$existing_id" ]; then
        curl -s -X DELETE "${KONG_ADMIN_URL}/consumers/${PROJECT_REF}/jwt/${existing_id}" > /dev/null
    fi

    # 创建新的 JWT 凭据
    curl -s -X POST "${KONG_ADMIN_URL}/consumers/${PROJECT_REF}/jwt" \
        -d "key=supabase" \
        -d "secret=${jwt_secret}" \
        -d "algorithm=HS256" > /dev/null
}

# 设置限流
set_rate_limit() {
    local tier="${1:-free}"
    local second=10
    local minute=100
    local hour=1000

    case "$tier" in
        pro)
            second=100; minute=2000; hour=50000 ;;
        enterprise)
            second=1000; minute=50000; hour=1000000 ;;
    esac

    # 为该项目的 Route 绑定 rate-limiting 插件
    # 假设 route 名称为 "route-${PROJECT_REF}"
    local route_name="route-${PROJECT_REF}"
    
    # 获取现有插件 ID (如果有)
    local plugin_id
    plugin_id=$(curl -s "${KONG_ADMIN_URL}/routes/${route_name}/plugins" | grep -oP '"id":"\K[^"]+' | head -1 || true)

    if [ -n "$plugin_id" ]; then
        # 更新现有插件
        curl -s -X PATCH "${KONG_ADMIN_URL}/plugins/${plugin_id}" \
            -d "config.second=${second}" \
            -d "config.minute=${minute}" \
            -d "config.hour=${hour}" \
            -d "config.policy=local" > /dev/null
    else
        # 创建新插件
        curl -s -X POST "${KONG_ADMIN_URL}/routes/${route_name}/plugins" \
            -d "name=rate-limiting" \
            -d "config.second=${second}" \
            -d "config.minute=${minute}" \
            -d "config.hour=${hour}" \
            -d "config.policy=local" > /dev/null
    fi
}

# 设置 CORS
set_cors() {
    local origins="${1:-*}"
    local route_name="route-${PROJECT_REF}"
    
    # 获取现有 cors 插件 ID
    local plugin_id
    plugin_id=$(curl -s "${KONG_ADMIN_URL}/routes/${route_name}/plugins?name=cors" | grep -oP '"id":"\K[^"]+' | head -1 || true)

    if [ -n "$plugin_id" ]; then
        curl -s -X PATCH "${KONG_ADMIN_URL}/plugins/${plugin_id}" \
            -d "config.origins=${origins}" \
            -d "config.methods=GET,POST,PUT,PATCH,DELETE,OPTIONS" \
            -d "config.headers=Accept,Accept-Version,Content-Length,Content-MD5,Content-Type,Date,X-Api-Version,X-Response-Time,X-PINGOTHER,X-CSRF-Token,Authorization" \
            -d "config.exposed_headers=Content-Length,X-JSON" \
            -d "config.credentials=true" \
            -d "config.max_age=3600" > /dev/null
    else
        curl -s -X POST "${KONG_ADMIN_URL}/routes/${route_name}/plugins" \
            -d "name=cors" \
            -d "config.origins=${origins}" \
            -d "config.methods=GET,POST,PUT,PATCH,DELETE,OPTIONS" \
            -d "config.credentials=true" \
            -d "config.max_age=3600" > /dev/null
    fi
}

# 启用 JWT 验证
enable_jwt() {
    local route_name="route-${PROJECT_REF}"
    
    # 检查是否已启用
    if ! curl -s "${KONG_ADMIN_URL}/routes/${route_name}/plugins" | grep -q '"name":"jwt"'; then
        curl -s -X POST "${KONG_ADMIN_URL}/routes/${route_name}/plugins" \
            -d "name=jwt" \
            -d "config.key_claim_name=iss" \
            -d "config.claims_to_verify=exp" > /dev/null
    fi
}

# ========== Per-Tenant Upstream（方案C+：多租户动态路由 - 声明式） ==========
# 将租户配置追加到 Kong Declarative YAML 中并热重载
rebuild_kong_config() {
    local KONG_YML="/etc/supabase/volumes/api/kong.yml"
    local KONG_BASE="${KONG_YML}.base"
    local TENANT_DIR="/etc/supabase/kong_tenants"
    
    # 初始化 base 全局配置备份
    if [ ! -f "$KONG_BASE" ]; then
        if [ -f "$KONG_YML" ]; then
            cp "$KONG_YML" "$KONG_BASE"
        else
            echo "WARNING: $KONG_YML not found, skip kong reload" >&2
            return
        fi
    fi
    
    local temp_yml
    temp_yml=$(mktemp)
    
    # 在 services: 后插入所有的租户服务配置段落
    awk -v tenant_dir="$TENANT_DIR" '
    /^services:/ {
        print $0
        system("if ls " tenant_dir "/*.yml >/dev/null 2>&1; then cat " tenant_dir "/*.yml; fi")
        next
    }
    { print $0 }
    ' "$KONG_BASE" > "$temp_yml"
    
    cat "$temp_yml" > "$KONG_YML"
    rm -f "$temp_yml"
    
    # 热重载 Kong 节点
    echo "Reloading Kong Gateway..."
    if docker ps -q -f "name=supabase-kong" | grep -q .; then
        docker exec supabase-kong kong reload
    elif podman ps -q -f "name=supabase-kong" | grep -q .; then
        podman exec supabase-kong kong reload
    else
        echo "WARNING: supabase-kong container not running"
    fi
}

setup_upstream() {
    local pgrst_port="${1:-}"
    local gotrue_port="${2:-}"
    
    if [ -z "$pgrst_port" ] || [ -z "$gotrue_port" ]; then
        echo "ERROR: pgrst_port and gotrue_port are required for setup-upstream" >&2
        exit 1
    fi

    mkdir -p /etc/supabase/kong_tenants
    local tenant_yml="/etc/supabase/kong_tenants/${PROJECT_REF}.yml"

    echo "Setting up Kong declarative configuration for ${PROJECT_REF}..."

    # 生成声明式的 Kong 配置文件
    cat > "$tenant_yml" <<EOF
  - name: svc-pgrst-${PROJECT_REF}
    url: http://127.0.0.1:${pgrst_port}
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-pgrst-${PROJECT_REF}
        strip_path: true
        preserve_host: true
        paths:
          - /rest/v1
          - /graphql/v1
        headers:
          X-Project-Ref:
            - ${PROJECT_REF}
  - name: svc-gotrue-${PROJECT_REF}
    url: http://127.0.0.1:${gotrue_port}
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-gotrue-${PROJECT_REF}
        strip_path: true
        preserve_host: true
        paths:
          - /auth/v1
        headers:
          X-Project-Ref:
            - ${PROJECT_REF}
EOF

    rebuild_kong_config
    echo "Kong upstream registered for ${PROJECT_REF} (pgrst:${pgrst_port}, gotrue:${gotrue_port})"
}

# 移除租户的 Kong Service/Route
remove_service() {
    echo "Removing Kong service for ${PROJECT_REF}..."
    rm -f "/etc/supabase/kong_tenants/${PROJECT_REF}.yml"
    rebuild_kong_config
    echo "Kong service removed for ${PROJECT_REF}"
}

# 主逻辑
validate_params

case "$ACTION" in
    setup-project)
        setup_jwt "${3:-}"
        ;;
    set-rate-limit)
        set_rate_limit "${3:-free}"
        ;;
    set-cors)
        set_cors "${3:-*}"
        ;;
    enable-jwt)
        enable_jwt
        ;;
    setup-upstream)
        setup_upstream "${3:-}" "${4:-}"
        ;;
    remove-service)
        remove_service
        ;;
    add-upstream-target)
        # 将副本加入负载均衡
        UPSTREAM_NAME="upstream-${PROJECT_REF}-ro"
        REPLICA_IP="${3:-}"
        curl -s -X POST "${KONG_ADMIN_URL}/upstreams" -d "name=${UPSTREAM_NAME}" > /dev/null || true
        curl -s -X POST "${KONG_ADMIN_URL}/upstreams/${UPSTREAM_NAME}/targets" \
            -d "target=${REPLICA_IP}:5432" \
            -d "weight=100" > /dev/null
        echo "Added ${REPLICA_IP} to upstream ${UPSTREAM_NAME}"
        ;;
    remove-upstream-target)
        UPSTREAM_NAME="upstream-${PROJECT_REF}-ro"
        REPLICA_IP="${3:-}"
        curl -s -X POST "${KONG_ADMIN_URL}/upstreams/${UPSTREAM_NAME}/targets" \
            -d "target=${REPLICA_IP}:5432" \
            -d "weight=0" > /dev/null
        echo "Removed ${REPLICA_IP} from upstream ${UPSTREAM_NAME}"
        ;;
    *)
        echo "ERROR: Unknown action '${ACTION}'" >&2
        exit 1
        ;;
esac

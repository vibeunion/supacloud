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

# ========== Per-Tenant Upstream（方案C：多租户动态路由） ==========
# 为每个租户创建独立 Kong Service → Route，指向该租户的 PostgREST 端口
# 请求通过 Nginx 设置的 X-Project-Ref header 进行匹配分发
setup_upstream() {
    local port="${3:-}"
    if [ -z "$port" ]; then
        echo "ERROR: Port is required for setup-upstream" >&2
        exit 1
    fi

    local service_name="svc-${PROJECT_REF}"
    local route_name="route-${PROJECT_REF}"

    echo "Setting up Kong upstream for ${PROJECT_REF} → 127.0.0.1:${port}..."

    # 创建/更新 Service（指向该租户的 PostgREST 端口）
    curl -s -X PUT "${KONG_ADMIN_URL}/services/${service_name}" \
        -d "name=${service_name}" \
        -d "url=http://127.0.0.1:${port}" \
        -d "connect_timeout=5000" \
        -d "read_timeout=60000" \
        -d "write_timeout=60000" > /dev/null

    # 创建/更新 Route（通过 X-Project-Ref header 匹配）
    # 使用 PUT 确保幂等
    curl -s -X PUT "${KONG_ADMIN_URL}/services/${service_name}/routes/${route_name}" \
        -d "name=${route_name}" \
        --data-urlencode "headers.X-Project-Ref=${PROJECT_REF}" \
        -d "strip_path=false" \
        -d "preserve_host=true" > /dev/null

    echo "Kong upstream registered: ${service_name} → 127.0.0.1:${port}"
}

# 移除租户的 Kong Service/Route
remove_service() {
    local service_name="svc-${PROJECT_REF}"
    local route_name="route-${PROJECT_REF}"

    echo "Removing Kong service for ${PROJECT_REF}..."

    # 先删除 Route（Route 依赖 Service）
    curl -s -X DELETE "${KONG_ADMIN_URL}/routes/${route_name}" > /dev/null 2>&1 || true

    # 再删除 Service
    curl -s -X DELETE "${KONG_ADMIN_URL}/services/${service_name}" > /dev/null 2>&1 || true

    # 删除 Consumer
    curl -s -X DELETE "${KONG_ADMIN_URL}/consumers/${PROJECT_REF}" > /dev/null 2>&1 || true

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
        setup_upstream
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

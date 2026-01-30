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
    add-upstream-target)
        # 将副本加入负载均衡
        # TARGET 为 project_ref, $3 为 replica_ip
        UPSTREAM_NAME="upstream-${PROJECT_REF}-ro"
        REPLICA_IP="${3:-}"
        # 确保 Upstream 存在
        curl -s -X POST "${KONG_ADMIN_URL}/upstreams" -d "name=${UPSTREAM_NAME}" > /dev/null || true
        # 添加 Target
        curl -s -X POST "${KONG_ADMIN_URL}/upstreams/${UPSTREAM_NAME}/targets" \
            -d "target=${REPLICA_IP}:5432" \
            -d "weight=100" > /dev/null
        log_info "Added ${REPLICA_IP} to upstream ${UPSTREAM_NAME}"
        ;;
    remove-upstream-target)
        # 移除副本
        UPSTREAM_NAME="upstream-${PROJECT_REF}-ro"
        REPLICA_IP="${3:-}"
        # Kong 移除 Target 通常是创建一个 weight=0 的新记录或直接删除（取决于版本）
        # 这里采用设置 weight=0 的方式
        curl -s -X POST "${KONG_ADMIN_URL}/upstreams/${UPSTREAM_NAME}/targets" \
            -d "target=${REPLICA_IP}:5432" \
            -d "weight=0" > /dev/null
        log_info "Removed ${REPLICA_IP} from upstream ${UPSTREAM_NAME}"
        ;;
    *)
        echo "ERROR: Unknown action '${ACTION}'" >&2
        exit 1
        ;;
esac

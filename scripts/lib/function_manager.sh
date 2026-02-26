#!/bin/bash
# SupaCloud - 边缘函数管理脚本 (多租户隔离版)
# 用法: function_manager.sh <action> <project_ref> [args...]

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"
KONG_ADMIN_URL="${KONG_ADMIN_URL:-http://localhost:8001}"

# 配置路径
TENANT_BASE_DIR="/etc/supabase/tenants"
FUNCTIONS_ROOT="/root/pigsty/app/supabase/volumes/functions"

# 验证参数
validate_params() {
    if [ -z "$ACTION" ] || [ -z "$PROJECT_REF" ]; then
        echo "ERROR: Missing required parameters" >&2
        echo "Usage: $0 <action> <project_ref> [args...]" >&2
        exit 1
    fi
}

# 获取租户配置及端口
get_tenant_config() {
    local env_file="${TENANT_BASE_DIR}/${PROJECT_REF}.env"
    if [ ! -f "$env_file" ]; then
        echo "ERROR: Tenant config not found at $env_file" >&2
        exit 1
    fi
    # 提取端口和重要密钥
    grep -E 'FUNCTIONS_PORT|SUPABASE_URL|ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET' "$env_file" | sed 's/ //g'
}

# 启动租户专属 Edge Runtime 容器
start_tenant_runtime() {
    echo "Starting isolated Edge Runtime for ${PROJECT_REF}..."
    local config
    config=$(get_tenant_config)
    
    local port=$(echo "$config" | grep "FUNCTIONS_PORT" | cut -d= -f2)
    if [ -z "$port" ]; then
        echo "ERROR: FUNCTIONS_PORT not defined for tenant ${PROJECT_REF}" >&2
        exit 1
    fi

    local container_name="supacloud-functions-${PROJECT_REF}"
    
    # 停止旧容器
    docker rm -f "$container_name" 2>/dev/null || true

    # 启动新容器
    # 挂载租户专用的函数目录 (如果需要更严格物理隔离，可以按租户分文件夹)
    docker run -d \
        --name "$container_name" \
        --network supabase_default \
        --restart always \
        -p "${port}:9000" \
        -v "${FUNCTIONS_ROOT}:/home/deno/functions:ro" \
        -e "JWT_SECRET=$(echo "$config" | grep "JWT_SECRET" | cut -d= -f2)" \
        -e "SUPABASE_URL=$(echo "$config" | grep "SUPABASE_URL" | cut -d= -f2)" \
        -e "SUPABASE_ANON_KEY=$(echo "$config" | grep "ANON_KEY" | cut -d= -f2)" \
        -e "SUPABASE_SERVICE_ROLE_KEY=$(echo "$config" | grep "SERVICE_ROLE_KEY" | cut -d= -f2)" \
        -e "PROJECT_REF=${PROJECT_REF}" \
        supabase/edge-runtime:v1.69.23 \
        start --main-service /home/deno/functions/main

    echo "Tenant runtime started at port ${port}"
}

# 停止租户专属容器
stop_tenant_runtime() {
    echo "Stopping Edge Runtime for ${PROJECT_REF}..."
    docker stop "supacloud-functions-${PROJECT_REF}" 2>/dev/null || true
    echo "Stopped."
}

# 检查状态
check_status() {
    docker ps -f "name=supacloud-functions-${PROJECT_REF}" --format "{{.Status}}"
}

# 主逻辑
validate_params

case "$ACTION" in
    start)
        start_tenant_runtime
        ;;
    stop)
        stop_tenant_runtime
        ;;
    status)
        check_status
        ;;
    deploy)
        # 兼容旧部署逻辑，但增加触发重启
        SLUG="${3:-}"
        CODE="${4:-}"
        if [ -z "$SLUG" ]; then echo "slug required" >&2; exit 1; fi
        
        DATA_DIR="${FUNCTIONS_ROOT}/${SLUG}"
        mkdir -p "$DATA_DIR"
        echo "$CODE" > "$DATA_DIR/index.ts"
        echo "Deployed $SLUG. Restarting runtime..."
        start_tenant_runtime
        ;;
    *)
        echo "Usage: $0 {start|stop|status|deploy} <project_ref> [args...]"
        exit 1
        ;;
esac

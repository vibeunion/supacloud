#!/bin/bash
# SupaCloud - 边缘函数管理脚本 (单实例 Web Worker 版)
# 用法: function_manager.sh <init_global|start|stop|status|deploy> <project_ref> [args...]

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-global}"
KONG_ADMIN_URL="${KONG_ADMIN_URL:-http://localhost:8001}"

GLOBAL_CONTAINER_NAME="supacloud-global-edge-runtime"
GLOBAL_PORT="9001"
TENANT_BASE_DIR="/etc/supabase/tenants"
FUNCTIONS_ROOT="/root/pigsty/app/supabase/volumes/functions"
ROUTER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 验证参数
validate_params() {
    if [ -z "$ACTION" ]; then
        echo "ERROR: Missing action parameter" >&2
        echo "Usage: $0 {init_global|start|stop|status|deploy} <project_ref> [args...]" >&2
        exit 1
    fi
}

# 租户配置与代码路径
TENANT_FUNCTIONS_DIR="${FUNCTIONS_ROOT}/${PROJECT_REF}"

# 确保租户函数目录存在
ensure_tenant_dir() {
    if [ "$PROJECT_REF" != "global" ]; then
        mkdir -p "$TENANT_FUNCTIONS_DIR"
    fi
}

# 初始化全局 Edge Runtime
init_global_runtime() {
    echo "Initializing Global Edge Runtime (Worker Router)..."
    
    # 停止旧的全局容器
    docker rm -f "$GLOBAL_CONTAINER_NAME" 2>/dev/null || true

    mkdir -p "$FUNCTIONS_ROOT"
    mkdir -p "$TENANT_BASE_DIR"

    # 将路由脚本同步到专门目录
    mkdir -p "${FUNCTIONS_ROOT}/_global_router"
    cp "${ROUTER_SCRIPT_DIR}/global_router.ts" "${FUNCTIONS_ROOT}/_global_router/main.ts"
    cp "${ROUTER_SCRIPT_DIR}/worker_runner.ts" "${FUNCTIONS_ROOT}/_global_router/worker_runner.ts"

    echo "Starting global container on port ${GLOBAL_PORT}..."
    docker run -d \
        --name "$GLOBAL_CONTAINER_NAME" \
        --network supabase_default \
        --restart always \
        --memory="300m" \
        --cpus="1.0" \
        --log-opt max-size=10m \
        --log-opt max-file=3 \
        -p "${GLOBAL_PORT}:9000" \
        -v "${FUNCTIONS_ROOT}:/home/deno/functions:ro" \
        -v "${TENANT_BASE_DIR}:${TENANT_BASE_DIR}:ro" \
        supabase/edge-runtime:v1.69.23 \
        start --main-service /home/deno/functions/_global_router/main

    echo "Global Edge Runtime initialized."
}

# 挂载租户到全局运行池 (虚拟操作)
start_tenant_runtime() {
    echo "Activate tenant ${PROJECT_REF} into global pool."
    if ! docker ps -q -f name="$GLOBAL_CONTAINER_NAME" | grep -q .; then
        init_global_runtime
    fi
}

# 停止租户
stop_tenant_runtime() {
    echo "Notice: Tenant Worker will be recycled automatically or upon redeploy."
}

# 检查状态
check_status() {
    if docker ps -q -f name="$GLOBAL_CONTAINER_NAME" | grep -q .; then
        echo "Running (Inside Global Pool)"
    else
        echo "Global Pool Offline"
    fi
}

# 主逻辑
validate_params

case "$ACTION" in
    init_global)
        init_global_runtime
        ;;
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
        SLUG="${3:-}"
        CODE="${4:-}"
        if [ -z "$SLUG" ]; then echo "slug required" >&2; exit 1; fi
        
        ensure_tenant_dir
        DATA_FILE="${TENANT_FUNCTIONS_DIR}/${SLUG}.ts"
        echo "$CODE" > "$DATA_FILE"
        echo "Deployed $SLUG to $TENANT_FUNCTIONS_DIR."
        start_tenant_runtime
        ;;
    read)
        SLUG="${3:-}"
        if [ -z "$SLUG" ]; then echo "slug required" >&2; exit 1; fi
        
        DATA_FILE="${TENANT_FUNCTIONS_DIR}/${SLUG}.ts"
        if [ -f "$DATA_FILE" ]; then
            cat "$DATA_FILE"
        else
            echo "Function not found" >&2
            exit 1
        fi
        ;;
    list)
        ensure_tenant_dir
        # Output JSON array of function slugs
        if [ -d "$TENANT_FUNCTIONS_DIR" ]; then
            # Use jq if available, otherwise fallback to simple formatting
            find "$TENANT_FUNCTIONS_DIR" -maxdepth 1 -name "*.ts" -type f -exec basename {} .ts \; | jq -R . | jq -s . || echo "[]"
        else
            echo "[]"
        fi
        ;;
    delete)
        SLUG="${3:-}"
        if [ -z "$SLUG" ]; then echo "slug required" >&2; exit 1; fi
        
        DATA_FILE="${TENANT_FUNCTIONS_DIR}/${SLUG}.ts"
        if [ -f "$DATA_FILE" ]; then
            rm -f "$DATA_FILE"
            echo "Deleted $SLUG."
        else
            echo "Function not found" >&2
            exit 1
        fi
        ;;
    *)
        echo "Usage: $0 {init_global|start|stop|status|deploy|read|list|delete} <project_ref> [args...]"
        exit 1
        ;;
esac

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

# 获取租户配置
get_tenant_config() {
    local env_file="${TENANT_BASE_DIR}/${PROJECT_REF}.env"
    if [ ! -f "$env_file" ]; then
        echo "ERROR: Tenant config not found at $env_file" >&2
        exit 1
    fi
    grep -E '^(FUNCTIONS_PORT|SUPABASE_URL|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|JWT_SECRET|WECHAT_APP_ID|WECHAT_APP_SECRET)=' "$env_file" | sed 's/ //g'
}

# 生成动态路由 (静态导入以适配 Edge Runtime 编译沙块)
generate_router() {
    local main_dir="${FUNCTIONS_ROOT}/main"
    local router_file="${main_dir}/index.ts"
    
    echo "Generating dynamic router at ${router_file}..."
    
    cat << 'EOF' > "$router_file"
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const functions: Record<string, any> = {};
EOF

    # 遍历所有函数文件 (排除 index.ts)
    for f in "$main_dir"/*.ts; do
        filename=$(basename "$f")
        if [ "$filename" == "index.ts" ]; then continue; fi
        slug="${filename%.*}"
        varname="func_${slug//-/_}"
        
        echo "import * as ${varname} from './${filename}'" >> "$router_file"
        echo "functions['${slug}'] = ${varname}.default;" >> "$router_file"
    done

    cat << 'EOF' >> "$router_file"

serve(async (req) => {
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  
  let functionName = '';
  if (url.pathname.startsWith('/functions/v1/')) {
      functionName = pathParts[3]; 
  } else {
      functionName = pathParts[pathParts.length - 1];
  }

  console.log(`Routing to function: ${functionName} from path: ${url.pathname}`);

  if (functions[functionName]) {
    try {
      return await functions[functionName](req);
    } catch (err: any) {
      console.error(`Handler error in ${functionName}:`, err);
      return new Response(JSON.stringify({ error: err.message || String(err) }), { 
          status: 500, 
          headers: { 'Content-Type': 'application/json' } 
      });
    }
  }
  
  if (!functionName || functionName === 'health' || functionName === '') {
    return new Response(JSON.stringify({ status: 'ok', message: 'Edge Runtime is running', available: Object.keys(functions) }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
    });
  }

  return new Response(JSON.stringify({ 
      error: `Function ${functionName} not found`,
      path: url.pathname,
      available: Object.keys(functions)
  }), { status: 404, headers: { 'Content-Type': 'application/json' } });
});
EOF
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
        
        # 部署到 main 根目录下，文件名为 slug.ts
        # 这样 index.ts 静态导入时结构扁平，可靠性最高
        DATA_FILE="${FUNCTIONS_ROOT}/main/${SLUG}.ts"
        mkdir -p "${FUNCTIONS_ROOT}/main"
        echo "$CODE" > "$DATA_FILE"
        echo "Deployed $SLUG. Generating router and restarting runtime..."
        start_tenant_runtime
        ;;
    *)
        echo "Usage: $0 {init_global|start|stop|status|deploy} <project_ref> [args...]"
        exit 1
        ;;
esac

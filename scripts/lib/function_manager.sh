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

# 启动租户专属 Edge Runtime 容器
start_tenant_runtime() {
    echo "Starting isolated Edge Runtime for ${PROJECT_REF}..."
    
    # 首先确保生成最新的路由
    generate_router

    local config
    config=$(get_tenant_config)
    
    local port=$(echo "$config" | grep "^FUNCTIONS_PORT=" | tail -n1 | cut -d= -f2)
    if [ -z "$port" ]; then
        echo "ERROR: FUNCTIONS_PORT not defined for tenant ${PROJECT_REF}" >&2
        exit 1
    fi

    local container_name="supacloud-functions-${PROJECT_REF}"
    
    # 停止旧容器
    docker rm -f "$container_name" 2>/dev/null || true

    # 提取环境变量
    local jwt_secret=$(echo "$config" | grep "^JWT_SECRET=" | tail -n1 | cut -d= -f2)
    local supabase_url=$(echo "$config" | grep "^SUPABASE_URL=" | tail -n1 | cut -d= -f2)
    local supabase_anon_key=$(echo "$config" | grep "^SUPABASE_ANON_KEY=" | tail -n1 | cut -d= -f2)
    local supabase_service_role_key=$(echo "$config" | grep "^SUPABASE_SERVICE_ROLE_KEY=" | tail -n1 | cut -d= -f2)
    local wechat_app_id=$(echo "$config" | grep "^WECHAT_APP_ID=" | tail -n1 | cut -d= -f2)
    local wechat_app_secret=$(echo "$config" | grep "^WECHAT_APP_SECRET=" | tail -n1 | cut -d= -f2)

    # 启动新容器
    docker run -d \
        --name "$container_name" \
        --network supabase_default \
        --restart always \
        -p "${port}:9000" \
        -v "${FUNCTIONS_ROOT}:/home/deno/functions:ro" \
        -e "JWT_SECRET=${jwt_secret}" \
        -e "SUPABASE_URL=${supabase_url}" \
        -e "SUPABASE_ANON_KEY=${supabase_anon_key}" \
        -e "SUPABASE_SERVICE_ROLE_KEY=${supabase_service_role_key}" \
        -e "WECHAT_APP_ID=${wechat_app_id}" \
        -e "WECHAT_APP_SECRET=${wechat_app_secret}" \
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
        echo "Usage: $0 {start|stop|status|deploy} <project_ref> [args...]"
        exit 1
        ;;
esac

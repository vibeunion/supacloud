#!/bin/bash
# SupaCloud - Edge Function Management Script (Single Instance Web Worker Version)
# Usage: function_manager.sh <init_global|start|stop|status|deploy> <project_ref> [args...]

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-global}"
KONG_ADMIN_URL="${KONG_ADMIN_URL:-http://localhost:8001}"

GLOBAL_CONTAINER_NAME="supacloud-global-edge-runtime"
GLOBAL_PORT="9001"
TENANT_BASE_DIR="/etc/supabase/tenants"
FUNCTIONS_ROOT="/root/pigsty/app/supabase/volumes/functions"
ROUTER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Validate parameters
validate_params() {
    if [ -z "$ACTION" ]; then
        echo "ERROR: Missing action parameter" >&2
        echo "Usage: $0 {init_global|start|stop|status|deploy} <project_ref> [args...]" >&2
        exit 1
    fi
}

# Get tenant configuration
get_tenant_config() {
    local env_file="${TENANT_BASE_DIR}/${PROJECT_REF}.env"
    if [ ! -f "$env_file" ]; then
        echo "ERROR: Tenant config not found at $env_file" >&2
        exit 1
    fi
    grep -E '^(FUNCTIONS_PORT|SUPABASE_URL|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|JWT_SECRET|WECHAT_APP_ID|WECHAT_APP_SECRET)=' "$env_file" | sed 's/ //g'
}

# Generate dynamic router (static import to adapt to Edge Runtime compile chunk)
generate_router() {
    local main_dir="${FUNCTIONS_ROOT}/main"
    local router_file="${main_dir}/index.ts"
    
    echo "Generating dynamic router at ${router_file}..."
    
    cat << 'EOF' > "$router_file"
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const functions: Record<string, any> = {};
EOF

    # Traverse all function files (exclude index.ts)
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

# Initialize Global Edge Runtime
init_global_runtime() {
    echo "Initializing Global Edge Runtime (Worker Router)..."
    
    # Stop old global container
    docker rm -f "$GLOBAL_CONTAINER_NAME" 2>/dev/null || true

    mkdir -p "$FUNCTIONS_ROOT"
    mkdir -p "$TENANT_BASE_DIR"

    # Sync router script to dedicated directory
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

# Mount tenant to global runtime pool (virtual operation)
start_tenant_runtime() {
    echo "Activate tenant ${PROJECT_REF} into global pool."
    if ! docker ps -q -f name="$GLOBAL_CONTAINER_NAME" | grep -q .; then
        init_global_runtime
    fi
}

# Stop tenant
stop_tenant_runtime() {
    echo "Notice: Tenant Worker will be recycled automatically or upon redeploy."
}

# Check status
check_status() {
    if docker ps -q -f name="$GLOBAL_CONTAINER_NAME" | grep -q .; then
        echo "Running (Inside Global Pool)"
    else
        echo "Global Pool Offline"
    fi
}

# Main logic
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
        
        # Deploy to main root directory, filename is slug.ts
        # This way index.ts static import structure is flat, most reliable
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

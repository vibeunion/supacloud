#!/bin/bash
# SupaCloud - Kong Gateway Management Script
# Usage: gateway_manager.sh <action> <project_ref> [args...]

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"
KONG_ADMIN_URL="${KONG_ADMIN_URL:-http://localhost:8001}"

# Validate parameters
validate_params() {
    if [ -z "$ACTION" ] || [ -z "$PROJECT_REF" ]; then
        echo "ERROR: Missing required parameters" >&2
        echo "Usage: $0 <action> <project_ref> [args...]" >&2
        exit 1
    fi
}

# Ensure Consumer exists
ensure_consumer() {
    curl -s -X POST "${KONG_ADMIN_URL}/consumers" \
        -d "username=${PROJECT_REF}" \
        -d "custom_id=${PROJECT_REF}" > /dev/null
}

# Set JWT credentials
setup_jwt() {
    local jwt_secret="$1"
    ensure_consumer
    
    # First try to delete old JWT credentials (if exists)
    local existing_id
    existing_id=$(curl -s "${KONG_ADMIN_URL}/consumers/${PROJECT_REF}/jwt" | grep -oP '"id":"\K[^"]+' | head -1 || true)
    if [ -n "$existing_id" ]; then
        curl -s -X DELETE "${KONG_ADMIN_URL}/consumers/${PROJECT_REF}/jwt/${existing_id}" > /dev/null
    fi

    # Create new JWT credentials
    curl -s -X POST "${KONG_ADMIN_URL}/consumers/${PROJECT_REF}/jwt" \
        -d "key=supabase" \
        -d "secret=${jwt_secret}" \
        -d "algorithm=HS256" > /dev/null
}

# Set rate limiting
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

    # Bind rate-limiting plugin for this project's Route
    # Assume route name is "route-${PROJECT_REF}"
    local route_name="route-${PROJECT_REF}"
    
    # Get existing plugin ID (if any)
    local plugin_id
    plugin_id=$(curl -s "${KONG_ADMIN_URL}/routes/${route_name}/plugins" | grep -oP '"id":"\K[^"]+' | head -1 || true)

    if [ -n "$plugin_id" ]; then
        # Update existing plugin
        curl -s -X PATCH "${KONG_ADMIN_URL}/plugins/${plugin_id}" \
            -d "config.second=${second}" \
            -d "config.minute=${minute}" \
            -d "config.hour=${hour}" \
            -d "config.policy=local" > /dev/null
    else
        # Create new plugin
        curl -s -X POST "${KONG_ADMIN_URL}/routes/${route_name}/plugins" \
            -d "name=rate-limiting" \
            -d "config.second=${second}" \
            -d "config.minute=${minute}" \
            -d "config.hour=${hour}" \
            -d "config.policy=local" > /dev/null
    fi
}

# Set CORS
set_cors() {
    local origins="${1:-*}"
    local route_name="route-${PROJECT_REF}"
    
    local plugin_id
    plugin_id=$(curl -s "${KONG_ADMIN_URL}/routes/${route_name}/plugins?name=cors" | grep -oP '"id":"\K[^"]+' | head -1 || true)

    if [ -n "$plugin_id" ]; then
        curl -s -X PATCH "${KONG_ADMIN_URL}/plugins/${plugin_id}" \
            -d "config.origins=${origins}" \
            -d "config.methods=GET,POST,PUT,PATCH,DELETE,OPTIONS" \
            -d "config.headers=Accept,Accept-Language,Authorization,Content-Language,Content-Type,apikey,x-client-info,x-project-ref" \
            -d "config.exposed_headers=Content-Length,Content-Range,X-Content-Range" \
            -d "config.credentials=false" \
            -d "config.max_age=86400" \
            -d "config.preflight_continue=false" > /dev/null
    else
        curl -s -X POST "${KONG_ADMIN_URL}/routes/${route_name}/plugins" \
            -d "name=cors" \
            -d "config.origins=${origins}" \
            -d "config.methods=GET,POST,PUT,PATCH,DELETE,OPTIONS" \
            -d "config.headers=Accept,Accept-Language,Authorization,Content-Language,Content-Type,apikey,x-client-info,x-project-ref" \
            -d "config.exposed_headers=Content-Length,Content-Range,X-Content-Range" \
            -d "config.credentials=false" \
            -d "config.max_age=86400" \
            -d "config.preflight_continue=false" > /dev/null
    fi
}

# Enable JWT verification
enable_jwt() {
    local route_name="route-${PROJECT_REF}"
    
    # Check if already enabled
    if ! curl -s "${KONG_ADMIN_URL}/routes/${route_name}/plugins" | grep -q '"name":"jwt"'; then
        curl -s -X POST "${KONG_ADMIN_URL}/routes/${route_name}/plugins" \
            -d "name=jwt" \
            -d "config.key_claim_name=iss" \
            -d "config.claims_to_verify=exp" > /dev/null
    fi
}

# ========== Per-Tenant Upstream (Plan C+: Multi-tenant dynamic routing - Declarative) ==========
# Append tenant configuration to Kong Declarative YAML and hot reload
rebuild_kong_config() {
    # Support overriding path via KONG_YML environment variable for different deployment scenarios (Pigsty / custom install)
    # Default path corresponds to Pigsty standard installation directory
    local KONG_YML="${KONG_YML:-/root/pigsty/app/supabase/volumes/api/kong.yml}"
    local KONG_BASE="${KONG_YML}.base"
    local TENANT_DIR="/etc/supabase/kong_tenants"
    
    # Initialize base global config backup
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
    
    # Insert all tenant service configuration blocks after services:
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
    
    # Hot reload Kong node
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
    # Complete fix: function must read its own positional parameters, $1 is pgrst_port, $2 is gotrue_port
    local pgrst_port="${1:-}"
    local gotrue_port="${2:-}"
    
    # Public /functions/v1 traffic must go through management-api first so sdk-proxy
    # can resolve tenant refs and apply background_routes before forwarding to the
    # shared edge runtime.
    local functions_port="${3:-${PORT:-9090}}"
    
    local storage_port="${4:-}"
    local realtime_port="${5:-}"

    if [ -z "$pgrst_port" ] || [ -z "$gotrue_port" ]; then
        echo "ERROR: pgrst_port and gotrue_port are required for setup-upstream" >&2
        exit 1
    fi

    # Detect host IP in container network (for Kong container to reverse access host processes)
    # Priority: environment variable > podman1 > docker0 > 127.0.0.1
    local host_ip="${DOCKER_HOST_IP:-}"
    if [ -z "$host_ip" ]; then
        host_ip=$(ip addr show podman1 2>/dev/null | grep "inet " | awk '{print $2}' | cut -d/ -f1 || true)
    fi
    if [ -z "$host_ip" ]; then
        host_ip=$(ip addr show docker0 2>/dev/null | grep "inet " | awk '{print $2}' | cut -d/ -f1 || true)
    fi
    if [ -z "$host_ip" ]; then
        host_ip="127.0.0.1"
        echo "WARNING: Could not detect container bridge IP, defaulting to 127.0.0.1 (may cause 502 if Kong runs in container)" >&2
    else
        echo "Detected container-accessible host IP: ${host_ip}"
    fi

    mkdir -p /etc/supabase/kong_tenants
    local tenant_yml="/etc/supabase/kong_tenants/${PROJECT_REF}.yml"

    echo "Setting up Kong declarative configuration for ${PROJECT_REF}..."

    # Generate declarative Kong configuration file
    cat > "$tenant_yml" <<EOF
  - name: svc-pgrst-${PROJECT_REF}
    url: http://${host_ip}:${pgrst_port}
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
          x-project-ref:
            - ${PROJECT_REF}
    plugins:
      - name: cors
        config:
          origins:
            - "~^https?://.*\\.dbbaby\\.top$"
            - "~^https?://localhost(:[0-9]+)?$"
            - "~^https?://127\\.0\\.0\\.1(:[0-9]+)?$"
          methods:
            - GET
            - POST
            - PUT
            - PATCH
            - DELETE
            - OPTIONS
          headers:
            - Accept
            - Accept-Language
            - Authorization
            - Content-Language
            - Content-Type
            - apikey
            - x-client-info
            - x-project-ref
          exposed_headers:
            - Content-Length
            - Content-Range
            - X-Content-Range
          credentials: false
          max_age: 86400
          preflight_continue: false
  - name: svc-gotrue-${PROJECT_REF}
    url: http://${host_ip}:${gotrue_port}
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
          x-project-ref:
            - ${PROJECT_REF}
    plugins:
      - name: cors
        config:
          origins:
            - "~^https?://.*\\.dbbaby\\.top$"
            - "~^https?://localhost(:[0-9]+)?$"
            - "~^https?://127\\.0\\.0\\.1(:[0-9]+)?$"
          methods:
            - GET
            - POST
            - PUT
            - PATCH
            - DELETE
            - OPTIONS
          headers:
            - Accept
            - Accept-Language
            - Authorization
            - Content-Language
            - Content-Type
            - apikey
            - x-client-info
            - x-project-ref
          exposed_headers:
            - Content-Length
            - Content-Range
            - X-Content-Range
          credentials: false
          max_age: 86400
          preflight_continue: false
EOF

    # Optional service: Edge Functions
    if [ -n "$functions_port" ]; then
        cat >> "$tenant_yml" <<EOF
  - name: svc-functions-${PROJECT_REF}
    url: http://${host_ip}:${functions_port}
    connect_timeout: 5000
    read_timeout: 500000
    write_timeout: 500000
    routes:
      - name: route-functions-${PROJECT_REF}
        strip_path: false
        preserve_host: true
        paths:
          - /functions/v1
          - /functions/v1/
        headers:
          x-project-ref:
            - ${PROJECT_REF}
    plugins:
      - name: cors
        config:
          origins:
            - "~^https?://.*\\.dbbaby\\.top$"
            - "~^https?://localhost(:[0-9]+)?$"
            - "~^https?://127\\.0\\.0\\.1(:[0-9]+)?$"
          methods:
            - GET
            - POST
            - PUT
            - PATCH
            - DELETE
            - OPTIONS
          headers:
            - Accept
            - Accept-Language
            - Authorization
            - Content-Language
            - Content-Type
            - apikey
            - x-client-info
            - x-project-ref
          exposed_headers:
            - Content-Length
            - Content-Range
            - X-Content-Range
          credentials: false
          max_age: 86400
          preflight_continue: false
EOF
    fi

    # Optional service: Storage
    if [ -n "$storage_port" ]; then
        cat >> "$tenant_yml" <<EOF
  - name: svc-storage-${PROJECT_REF}
    url: http://${host_ip}:${storage_port}
    connect_timeout: 5000
    read_timeout: 500000
    write_timeout: 500000
    routes:
      - name: route-storage-${PROJECT_REF}
        strip_path: true
        preserve_host: true
        request_buffering: false
        response_buffering: false
        paths:
          - /storage/v1
        headers:
          x-project-ref:
            - ${PROJECT_REF}
    plugins:
      - name: cors
        config:
          origins:
            - "~^https?://.*\\.dbbaby\\.top$"
            - "~^https?://localhost(:[0-9]+)?$"
            - "~^https?://127\\.0\\.0\\.1(:[0-9]+)?$"
          methods:
            - GET
            - POST
            - PUT
            - PATCH
            - DELETE
            - OPTIONS
          headers:
            - Accept
            - Accept-Language
            - Authorization
            - Content-Language
            - Content-Type
            - apikey
            - x-client-info
            - x-project-ref
          exposed_headers:
            - Content-Length
            - Content-Range
            - X-Content-Range
          credentials: false
          max_age: 86400
          preflight_continue: false
EOF
    fi

    # Optional service: Realtime
    if [ -n "$realtime_port" ]; then
        cat >> "$tenant_yml" <<EOF
  - name: svc-realtime-${PROJECT_REF}
    url: http://${host_ip}:${realtime_port}
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-realtime-${PROJECT_REF}
        strip_path: true
        preserve_host: true
        paths:
          - /realtime/v1
        headers:
          x-project-ref:
            - ${PROJECT_REF}
    plugins:
      - name: cors
        config:
          origins:
            - "~^https?://.*\\.dbbaby\\.top$"
            - "~^https?://localhost(:[0-9]+)?$"
            - "~^https?://127\\.0\\.0\\.1(:[0-9]+)?$"
          methods:
            - GET
            - POST
            - PUT
            - PATCH
            - DELETE
            - OPTIONS
          headers:
            - Accept
            - Accept-Language
            - Authorization
            - Content-Language
            - Content-Type
            - apikey
            - x-client-info
            - x-project-ref
          exposed_headers:
            - Content-Length
            - Content-Range
            - X-Content-Range
          credentials: false
          max_age: 86400
          preflight_continue: false
EOF
    fi

    rebuild_kong_config
    echo "Kong upstream registered for ${PROJECT_REF} (pgrst:${pgrst_port}, gotrue:${gotrue_port})"
}

# Remove tenant's Kong Service/Route
remove_service() {
    echo "Removing Kong service for ${PROJECT_REF}..."
    rm -f "/etc/supabase/kong_tenants/${PROJECT_REF}.yml"
    rebuild_kong_config
    echo "Kong service removed for ${PROJECT_REF}"
}

# Main logic
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
        # Complete fix: explicitly pass positional parameters $3 to $7 to function internals
        setup_upstream "${3:-}" "${4:-}" "${5:-}" "${6:-}" "${7:-}"
        ;;
    remove-service)
        remove_service
        ;;
    add-upstream-target)
        # Add replica to load balancer
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

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

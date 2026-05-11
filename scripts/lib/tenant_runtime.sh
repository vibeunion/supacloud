#!/bin/bash
# SupaCloud - Tenant Runtime Management Script
# Dynamically starts independent PostgREST processes for each tenant, binding to unique ports, connecting to dedicated tenant databases
# Usage: tenant_runtime.sh <start|stop|restart|status|port> <project_ref>

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"

# Configuration
TENANT_CONFIG_DIR="${TENANT_CONFIG_DIR:-/etc/supabase/tenants}"
POSTGREST_BIN="${POSTGREST_BIN:-/usr/local/bin/postgrest}"
GOTRUE_BIN="${GOTRUE_BIN:-/usr/local/bin/gotrue}"
PG_HOST="${PG_HOST:-${POSTGRES_HOST:-localhost}}"
PG_PORT="${PG_PORT:-${POSTGRES_PORT:-6432}}"
PGRST_PORT_BASE="${PGRST_PORT_BASE:-3100}"
GOTRUE_PORT_BASE="${GOTRUE_PORT_BASE:-4100}"
PORT_RANGE="${PORT_RANGE:-10000}"
SUPACLOUD_META_DB="${SUPACLOUD_META_DB:-supacloud_meta}"
POSTGREST_RTS="${POSTGREST_RTS:--N1 -M256m -I0.5 -A4m}"
POSTGREST_MEMORY_MAX="${POSTGREST_MEMORY_MAX:-384M}"
POSTGREST_CPU_WEIGHT="${POSTGREST_CPU_WEIGHT:-40}"

# Validate parameters
validate_params() {
    if [ -z "$ACTION" ] || [ -z "$PROJECT_REF" ]; then
        echo "ERROR: Missing required parameters" >&2
        echo "Usage: $0 <start|stop|restart|status|port> <project_ref>" >&2
        exit 1
    fi
}

# ========== Port allocation (deterministic hash, avoid conflicts) ==========
get_tenant_port() {
    local ref="$1"
    local type="$2" # pgrst or gotrue
    local base_port

    if [ "$type" = "pgrst" ]; then
        base_port=$PGRST_PORT_BASE
    elif [ "$type" = "gotrue" ]; then
        base_port=$GOTRUE_PORT_BASE
    else
        echo "ERROR: Unknown port type $type" >&2
        exit 1
    fi

    local hash
    hash=$(echo -n "$ref" | cksum | awk '{print $1}')
    local port=$(( base_port + (hash % PORT_RANGE) ))

    # Conflict detection: if port is occupied by another tenant, linear probe
    local config_dir="$TENANT_CONFIG_DIR"
    local max_tries=100
    local try=0
    while [ $try -lt $max_tries ]; do
        local conflict=false
        if [ -d "$config_dir" ]; then
            for f in "$config_dir"/*.env; do
                [ -f "$f" ] || continue
                local existing_ref
                # Support ref.env (pgrst) and ref_gotrue.env (gotrue)
                existing_ref=$(basename "$f" | sed -e 's/\.env$//' -e 's/_gotrue$//')
                [ "$existing_ref" = "$ref" ] && continue
                
                local search_str="PGRST_SERVER_PORT=${port}"
                [ "$type" = "gotrue" ] && search_str="GOTRUE_API_PORT=${port}"

                if grep -q "$search_str" "$f" 2>/dev/null; then
                    conflict=true
                    break
                fi
            done
        fi
        if [ "$conflict" = false ]; then
            echo "$port"
            return
        fi
        port=$(( port + 1 ))
        try=$(( try + 1 ))
    done

    echo "ERROR: Cannot find available port for ${ref} (${type})" >&2
    exit 1
}

# ========== Query tenant credentials from supacloud_meta ==========
get_tenant_credentials() {
    local ref="$1"
    local field="$2"

    # Use database connection info from environment variables
    # Prefer PG_USER and PGPASSWORD, otherwise fallback to supabase_admin
    local db_user="${PG_USER:-supabase_admin}"
    local db_pass="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
    
    if [ -z "$db_pass" ]; then
        echo "ERROR: PGPASSWORD or POSTGRES_PASSWORD not set" >&2
        exit 1
    fi
    
    PGPASSWORD="$db_pass" psql \
        -h "$PG_HOST" -p "$PG_PORT" -U "$db_user" \
        -d "$SUPACLOUD_META_DB" \
        -t -A -c "SELECT ${field} FROM projects WHERE ref='${ref}'" 2>/dev/null | grep -v '^Time:' | head -n 1
}

# ========== Ensure PostgREST binary is available ==========
ensure_postgrest() {
    if command -v postgrest &>/dev/null; then
        POSTGREST_BIN=$(command -v postgrest)
        return
    fi

    if [ -x "$POSTGREST_BIN" ]; then
        return
    fi

    echo "PostgREST binary not found. Installing..."

    # Direct download
    local arch
    arch=$(uname -m)
    case "$arch" in
        x86_64) arch="linux-static-x64" ;;
        aarch64) arch="linux-static-aarch64" ;;
        *) echo "ERROR: Unsupported architecture: $arch" >&2; exit 1 ;;
    esac

    local version="v12.2.3"
    local url="https://github.com/PostgREST/postgrest/releases/download/${version}/postgrest-${version}-${arch}.tar.xz"
    echo "Downloading PostgREST ${version}..."

    local tmp_dir
    tmp_dir=$(mktemp -d)
    if curl -fsSL "https://gh-proxy.net/${url}" -o "${tmp_dir}/postgrest.tar.xz" 2>/dev/null || \
       curl -fsSL "${url}" -o "${tmp_dir}/postgrest.tar.xz"; then
        tar -xf "${tmp_dir}/postgrest.tar.xz" -C "${tmp_dir}"
        mv "${tmp_dir}/postgrest" "$POSTGREST_BIN"
        chmod +x "$POSTGREST_BIN"
        echo "PostgREST installed to $POSTGREST_BIN"
    else
        echo "ERROR: Failed to download PostgREST" >&2
        rm -rf "$tmp_dir"
        exit 1
    fi
    rm -rf "$tmp_dir"
}

# ========== Ensure GoTrue binary is available ==========
ensure_gotrue() {
    if command -v gotrue &>/dev/null; then
        GOTRUE_BIN=$(command -v gotrue)
        return
    fi

    if [ -x "$GOTRUE_BIN" ]; then
        return
    fi

    echo "GoTrue binary not found. Installing..."

    # Direct download from GitHub
    local arch
    arch=$(uname -m)
    case "$arch" in
        x86_64) arch="linux-amd64" ;;
        aarch64) arch="linux-arm64" ;;
        *) echo "ERROR: Unsupported architecture: $arch" >&2; exit 1 ;;
    esac

    local version="v2.164.0"
    local url="https://github.com/supabase/auth/releases/download/${version}/auth-${version}-${arch}.tar.gz"
    echo "Downloading GoTrue ${version}..."

    local tmp_dir
    tmp_dir=$(mktemp -d)
    if curl -fsSL "https://gh-proxy.net/${url}" -o "${tmp_dir}/gotrue.tar.gz" 2>/dev/null || \
       curl -fsSL "${url}" -o "${tmp_dir}/gotrue.tar.gz"; then
        tar -xf "${tmp_dir}/gotrue.tar.gz" -C "${tmp_dir}"
        # The binary may be named 'auth' or 'gotrue' depending on the release
        if [ -f "${tmp_dir}/auth" ]; then
            mv "${tmp_dir}/auth" "$GOTRUE_BIN"
        elif [ -f "${tmp_dir}/gotrue" ]; then
            mv "${tmp_dir}/gotrue" "$GOTRUE_BIN"
        fi
        chmod +x "$GOTRUE_BIN"
        echo "GoTrue installed to $GOTRUE_BIN"
    else
        echo "ERROR: Failed to download GoTrue. Please manually place the binary at $GOTRUE_BIN" >&2
        rm -rf "$tmp_dir"
        exit 1
    fi
    rm -rf "$tmp_dir"
}

# ========== Generate tenant configuration files ==========
generate_tenant_config() {
    local ref="$1"
    local pgrst_port="$2"
    local gotrue_port="$3"

    mkdir -p "$TENANT_CONFIG_DIR"

    # Query tenant credentials
    local db_name="supa_${ref}"
    local db_password
    db_password=$(get_tenant_credentials "$ref" "db_password")
    local jwt_secret
    jwt_secret=$(get_tenant_credentials "$ref" "jwt_secret")

    if [ -z "$db_password" ] || [ -z "$jwt_secret" ]; then
        echo "ERROR: Cannot find credentials for project ${ref} in supacloud_meta" >&2
        exit 1
    fi

    # Query tenant's API external access URL (for GoTrue API_EXTERNAL_URL)
    # Priority: environment variable override > supacloud_meta.projects.api_url > default placeholder
    local api_external_url="${GOTRUE_API_EXTERNAL_URL:-}"
    if [ -z "$api_external_url" ]; then
        api_external_url=$(get_tenant_credentials "$ref" "api_url" 2>/dev/null || true)
    fi
    if [ -z "$api_external_url" ]; then
        api_external_url="https://your-supacloud-domain.com"
        echo "WARNING: API_EXTERNAL_URL not set. Set GOTRUE_API_EXTERNAL_URL env var or add api_url to supacloud_meta.projects" >&2
    fi

    # 1. Generate PostgREST .env and .conf
    cat > "${TENANT_CONFIG_DIR}/${ref}.env" <<EOF
# SupaCloud Tenant PostgREST Runtime: ${ref}
PGRST_DB_URI=postgres://authenticator_${ref}:${db_password}@${PG_HOST}:${PG_PORT}/${db_name}
PGRST_DB_SCHEMAS=public,storage,graphql_public
PGRST_DB_EXTRA_SEARCH_PATH=public
PGRST_DB_ANON_ROLE=anon
PGRST_JWT_SECRET=${jwt_secret}
PGRST_SERVER_PORT=${pgrst_port}
PGRST_DB_POOL=3
PGRST_DB_POOL_ACQUISITION_TIMEOUT=10
PGRST_LOG_LEVEL=warn
EOF
    chmod 644 "${TENANT_CONFIG_DIR}/${ref}.env"

    cat > "${TENANT_CONFIG_DIR}/${ref}.conf" <<EOF
# PostgREST config for tenant: ${ref}
db-uri = "postgres://authenticator_${ref}:${db_password}@${PG_HOST}:${PG_PORT}/${db_name}"
db-schemas = "public, storage, graphql_public"
# Bug Fix: Multi-tenant isolation - extra search path should include tenant-specific schema
db-extra-search-path = "public, extensions, auth, ${ref}"
db-anon-role = "anon"
jwt-secret = "${jwt_secret}"
server-port = ${pgrst_port}
# Bug Fix: Bind to 0.0.0.0 to allow Kong container (podman/docker network) access via host bridge IP
server-host = "0.0.0.0"
db-pool = 3
db-pool-acquisition-timeout = 10
log-level = "warn"
db-channel = "pgrst_${ref}"
EOF
    chmod 644 "${TENANT_CONFIG_DIR}/${ref}.conf"

    # 2. Generate GoTrue .env
    # Get tenant configured email sender (if any)
    local gotrue_sender="${GOTRUE_SMTP_ADMIN_EMAIL:-noreply@${api_external_url#https://}}"
    local smtp_host="${GOTRUE_SMTP_HOST:-}"
    local smtp_user="${GOTRUE_SMTP_USER:-}"
    local smtp_pass="${GOTRUE_SMTP_PASS:-}"
    
    cat > "${TENANT_CONFIG_DIR}/${ref}_gotrue.env" <<EOF
# SupaCloud Tenant GoTrue Runtime: ${ref}
# Bug Fix: Bind to 0.0.0.0 to allow Kong container access via host bridge IP
GOTRUE_API_HOST=0.0.0.0
GOTRUE_API_PORT=${gotrue_port}
# Required: external URL used for email verification links and OAuth redirects
API_EXTERNAL_URL=${api_external_url}
# Bug Fix: SITE_URL should be the actually accessible URL
GOTRUE_SITE_URL=${api_external_url}
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${PGPASSWORD:-${POSTGRES_PASSWORD:-postgres}}@${PG_HOST}:${PG_PORT}/${db_name}

GOTRUE_JWT_SECRET=${jwt_secret}
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_AUD=authenticated
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
# Bug Fix: Must set JWT_AUD, otherwise user queries will be filtered out due to empty aud
GOTRUE_JWT_AUD=authenticated
GOTRUE_LOG_LEVEL=info
GOTRUE_SERVER_READ_TIMEOUT=20
GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION=true
EOF

    # If SMTP is configured, add to GoTrue config
    if [ -n "$smtp_host" ]; then
        cat >> "${TENANT_CONFIG_DIR}/${ref}_gotrue.env" <<EOF
# SMTP Configuration
GOTRUE_SMTP_ADMIN_EMAIL=${gotrue_sender}
GOTRUE_SMTP_HOST=${smtp_host}
GOTRUE_SMTP_PORT=587
GOTRUE_SMTP_USER=${smtp_user}
GOTRUE_SMTP_PASS=${smtp_pass}
GOTRUE_SMTP_SENDER_NAME=SupaCloud
EOF
    fi
    chmod 644 "${TENANT_CONFIG_DIR}/${ref}_gotrue.env"

    echo "Config generated for ${ref} (pgrst_port=${pgrst_port}, gotrue_port=${gotrue_port})"
}

# ========== Install systemd template unit ==========
install_systemd_template() {
    local pgrst_unit="/etc/systemd/system/supacloud-pgrst@.service"
    if [ ! -f "$pgrst_unit" ] || grep -Eq -- '-M30m|MemoryMax=45M' "$pgrst_unit"; then
        cat > "$pgrst_unit" <<EOF
[Unit]
Description=SupaCloud PostgREST for tenant %i
Documentation=https://github.com/supacloud/supacloud
After=network.target patroni.service
Wants=patroni.service

[Service]
Type=simple
User=nobody
Group=nobody
EnvironmentFile=/etc/supabase/tenants/%i.env
# Keep PostgREST bounded without starving large REST reads/upserts.
Environment="GHCRTS=${POSTGREST_RTS}"
ExecStart=${POSTGREST_BIN} /etc/supabase/tenants/%i.conf +RTS ${POSTGREST_RTS} -RTS
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60

# Security and resource sandboxing
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/supabase/tenants
MemoryMax=${POSTGREST_MEMORY_MAX}
CPUWeight=${POSTGREST_CPU_WEIGHT}

[Install]
WantedBy=multi-user.target
EOF
    fi

    local gotrue_unit="/etc/systemd/system/supacloud-gotrue@.service"
    if [ ! -f "$gotrue_unit" ]; then
        cat > "$gotrue_unit" <<EOF
[Unit]
Description=SupaCloud GoTrue for tenant %i
Documentation=https://github.com/supacloud/supacloud
After=network.target patroni.service
Wants=patroni.service

[Service]
Type=simple
User=nobody
Group=nobody
EnvironmentFile=/etc/supabase/tenants/%i_gotrue.env
# Extreme squeeze: Go native memory wall 15MB and trigger GC immediately at 20% growth
Environment="GOMEMLIMIT=15MiB"
Environment="GOGC=20"
ExecStart=${GOTRUE_BIN}
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60

# Security and resource sandboxing
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/supabase/tenants
MemoryMax=30M
CPUWeight=20

[Install]
WantedBy=multi-user.target
EOF
    fi

    systemctl daemon-reload
    echo "systemd template units installed"
}

# ========== Start tenant runtime ==========
start_runtime() {
    local ref="$1"

    ensure_postgrest
    ensure_gotrue
    install_systemd_template

    local pgrst_port
    pgrst_port=$(get_tenant_port "$ref" "pgrst")
    local gotrue_port
    gotrue_port=$(get_tenant_port "$ref" "gotrue")

    # Generate config
    generate_tenant_config "$ref" "$pgrst_port" "$gotrue_port"

    # Start systemd services
    systemctl enable "supacloud-pgrst@${ref}" 2>/dev/null || true
    systemctl start "supacloud-pgrst@${ref}"
    
    systemctl enable "supacloud-gotrue@${ref}" 2>/dev/null || true
    systemctl start "supacloud-gotrue@${ref}"

    # Wait for health check (check both ports)
    echo "Waiting for PostgREST(${pgrst_port}) and GoTrue(${gotrue_port})..."
    local retries=20
    local pgrst_ok=0
    local gotrue_ok=0
    
    while [ $retries -gt 0 ]; do
        if [ $pgrst_ok -eq 0 ] && curl -sf "http://127.0.0.1:${pgrst_port}/" >/dev/null 2>&1; then
            pgrst_ok=1
        fi
        if [ $gotrue_ok -eq 0 ] && curl -sf "http://127.0.0.1:${gotrue_port}/health" >/dev/null 2>&1; then
            gotrue_ok=1
        fi
        
        if [ $pgrst_ok -eq 1 ] && [ $gotrue_ok -eq 1 ]; then
            echo "RUNTIME_STARTED=true"
            echo "PORT=${pgrst_port}"
            echo "GOTRUE_PORT=${gotrue_port}"
            echo "STATUS=running"
            return
        fi
        sleep 1
        retries=$((retries - 1))
    done

    echo "WARNING: Health check timeout, some services may still be starting" >&2
    echo "RUNTIME_STARTED=true"
    echo "PORT=${pgrst_port}"
    echo "GOTRUE_PORT=${gotrue_port}"
    echo "STATUS=starting"
}

# ========== Stop tenant runtime ==========
stop_runtime() {
    local ref="$1"

    systemctl stop "supacloud-pgrst@${ref}" 2>/dev/null || true
    systemctl disable "supacloud-pgrst@${ref}" 2>/dev/null || true
    
    systemctl stop "supacloud-gotrue@${ref}" 2>/dev/null || true
    systemctl disable "supacloud-gotrue@${ref}" 2>/dev/null || true

    # Clean up config files
    rm -f "${TENANT_CONFIG_DIR}/${ref}.env" "${TENANT_CONFIG_DIR}/${ref}.conf" "${TENANT_CONFIG_DIR}/${ref}_gotrue.env"

    echo "Runtime stopped for ${ref}"
}

# ========== Restart tenant runtime ==========
restart_runtime() {
    local ref="$1"

    if systemctl is-active "supacloud-pgrst@${ref}" >/dev/null 2>&1 || systemctl is-active "supacloud-gotrue@${ref}" >/dev/null 2>&1; then
        # Bug Fix: Before restart, also need to ensure binary and systemd template exist, prevent crash if .service not allocated
        ensure_postgrest
        ensure_gotrue
        install_systemd_template

        # Regenerate config (credentials may have been updated)
        local pgrst_port
        pgrst_port=$(get_tenant_port "$ref" "pgrst")
        local gotrue_port
        gotrue_port=$(get_tenant_port "$ref" "gotrue")
        
        generate_tenant_config "$ref" "$pgrst_port" "$gotrue_port"
        
        systemctl restart "supacloud-pgrst@${ref}"
        systemctl restart "supacloud-gotrue@${ref}"
        echo "Runtime restarted for ${ref} (pgrst=${pgrst_port}, gotrue=${gotrue_port})"
    else
        # Not running, start it
        start_runtime "$ref"
    fi
}

# ========== Check status ==========
check_status() {
    local ref="$1"

    local pgrst_running=false
    local gotrue_running=false
    
    systemctl is-active "supacloud-pgrst@${ref}" >/dev/null 2>&1 && pgrst_running=true
    systemctl is-active "supacloud-gotrue@${ref}" >/dev/null 2>&1 && gotrue_running=true

    if [ "$pgrst_running" = true ] || [ "$gotrue_running" = true ]; then
        local pgrst_port
        pgrst_port=$(get_tenant_port "$ref" "pgrst")
        local gotrue_port
        gotrue_port=$(get_tenant_port "$ref" "gotrue")
        
        local health="unhealthy"
        if curl -sf "http://127.0.0.1:${pgrst_port}/" >/dev/null 2>&1 && curl -sf "http://127.0.0.1:${gotrue_port}/health" >/dev/null 2>&1; then
            health="healthy"
        elif curl -sf "http://127.0.0.1:${pgrst_port}/" >/dev/null 2>&1 || curl -sf "http://127.0.0.1:${gotrue_port}/health" >/dev/null 2>&1; then
            health="degraded"
        fi
        
        echo "STATUS=running"
        echo "PORT=${pgrst_port}"
        echo "GOTRUE_PORT=${gotrue_port}"
        echo "HEALTH=${health}"
    else
        echo "STATUS=stopped"
    fi
}

# ========== Get port ==========
get_port() {
    local ref="$1"
    local pgrst_port
    pgrst_port=$(get_tenant_port "$ref" "pgrst")
    local gotrue_port
    gotrue_port=$(get_tenant_port "$ref" "gotrue")
    echo "PORT=${pgrst_port}"
    echo "GOTRUE_PORT=${gotrue_port}"
}

# Main logic
validate_params

case "$ACTION" in
    start)
        start_runtime "$PROJECT_REF"
        ;;
    stop)
        stop_runtime "$PROJECT_REF"
        ;;
    restart)
        restart_runtime "$PROJECT_REF"
        ;;
    status)
        check_status "$PROJECT_REF"
        ;;
    port)
        get_port "$PROJECT_REF"
        ;;
    *)
        echo "ERROR: Unknown action '${ACTION}'. Use: start, stop, restart, status, port" >&2
        exit 1
        ;;
esac

#!/bin/bash
# SupaCloud - Health Check Script
# Usage: health_check.sh [service]

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

check_postgrest_tenant_runtimes() {
    local tenant_dir="/etc/supabase/tenants"
    local checked=0
    local unhealthy=0

    if [[ ! -d "$tenant_dir" ]]; then
        echo -e "${YELLOW}?${NC} Tenant PostgREST (config dir missing: $tenant_dir)"
        return 0
    fi

    shopt -s nullglob
    for conf in "$tenant_dir"/*.conf; do
        [[ "$conf" == *.bak* ]] && continue

        local tenant="${conf##*/}"
        tenant="${tenant%.conf}"

        local port
        port=$(sed -n 's/^server-port = \([0-9][0-9]*\)$/\1/p' "$conf" | head -n 1)
        checked=$((checked + 1))

        if [[ -z "$port" ]]; then
            echo -e "${RED}✗${NC} Tenant PostgREST ${tenant} (missing server-port)"
            unhealthy=$((unhealthy + 1))
            continue
        fi

        if curl -fsS --max-time 3 "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
            echo -e "${GREEN}✓${NC} Tenant PostgREST ${tenant} (${port})"
            continue
        fi

        unhealthy=$((unhealthy + 1))
        local detail
        detail=$(journalctl -u "supacloud-pgrst@${tenant}" -n 20 --no-pager 2>/dev/null \
            | grep -E 'PGRST002|Failed to load the schema cache|schema "pgmq_public" does not exist' \
            | tail -n 1 || true)
        if [[ -n "$detail" ]]; then
            echo -e "${RED}✗${NC} Tenant PostgREST ${tenant} (${port}) ${detail}"
        else
            echo -e "${RED}✗${NC} Tenant PostgREST ${tenant} (${port})"
        fi
    done
    shopt -u nullglob

    if [[ "$checked" -eq 0 ]]; then
        echo -e "${YELLOW}?${NC} Tenant PostgREST (no tenant configs found)"
        return 0
    fi

    if [[ "$unhealthy" -gt 0 ]]; then
        echo -e "${RED}✗${NC} Tenant PostgREST summary (${unhealthy}/${checked} unhealthy)"
        return 1
    fi

    echo -e "${GREEN}✓${NC} Tenant PostgREST summary (${checked} healthy)"
    return 0
}

check_service() {
    local name="$1"
    local check_cmd="$2"

    if eval "$check_cmd" &>/dev/null; then
        echo -e "${GREEN}✓${NC} $name"
        return 0
    else
        echo -e "${RED}✗${NC} $name"
        return 1
    fi
}

check_postgresql_recovery() {
    local pg_data="${PGDATA:-/pg/data}"
    local pid_file="${pg_data}/postmaster.pid"
    
    if [[ -f "$pid_file" ]]; then
        local pid
        pid=$(head -1 "$pid_file" 2>/dev/null)
        if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
            echo -e "${YELLOW}!${NC} PostgreSQL stale PID file detected, removing..."
            rm -f "$pid_file"
            echo -e "${YELLOW}!${NC} Attempting to restart PostgreSQL via Patroni..."
            systemctl restart patroni 2>/dev/null || true
            return 1
        fi
    fi
    return 0
}

echo "SupaCloud Health Check"
echo "=================="
echo ""

# Check Patroni (PostgreSQL HA)
if systemctl is-active --quiet patroni 2>/dev/null; then
    check_service "Patroni (HA)" "systemctl is-active patroni"
    check_postgresql_recovery
else
    check_service "PostgreSQL (5432)" "pg_isready -h localhost -p 5432"
fi

# Check Management API
check_service "Management API (9090)" "curl -sf http://localhost:9090/health"

# Check Caddy Gateway
check_service "Caddy Gateway HTTP (80)" "ss -ltn | grep -q ':80 '"
check_service "Caddy Gateway HTTPS/TCP (443)" "ss -ltn | grep -q ':443 '"
check_service "Caddy Gateway HTTP3/QUIC (443)" "ss -lun | grep -q ':443 '"
check_service "Caddy Admin API (2019)" "curl -sf http://127.0.0.1:2019/config/ >/dev/null"

# Check SupaCloud service runtimes
check_service "Image Service (9010)" "ss -ltn | grep -q ':9010 '"
check_service "Realtime Admin (4000)" "ss -ltn | grep -q ':4000 '"

# Check active tenant runtimes
active_tenants=$(systemctl list-units 'supacloud-gotrue@*.service' --state=running --no-legend 2>/dev/null | wc -l)
if [[ "$active_tenants" -gt 0 ]]; then
    echo -e "${GREEN}✓${NC} Active tenants: $active_tenants"
else
    echo -e "${YELLOW}?${NC} No active tenant runtimes"
fi

check_postgrest_tenant_runtimes

# Check S3 Storage
if systemctl is-active --quiet juicefs-s3 2>/dev/null; then
    check_service "JuiceFS S3 Gateway (9000)" "curl -sf http://localhost:9000/minio/health/live"
elif systemctl is-active --quiet rustfs 2>/dev/null; then
    check_service "RustFS (9000)" "curl -sf http://localhost:9000"
elif systemctl is-active --quiet minio 2>/dev/null; then
    check_service "MinIO (9000)" "curl -sf http://localhost:9000"
else
    echo -e "${YELLOW}?${NC} S3 Storage (No service detected)"
fi

echo ""
echo "Check complete"

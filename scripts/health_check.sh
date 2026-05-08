#!/bin/bash
# SupaCloud - Health Check Script
# Usage: health_check.sh [service]

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

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

# Check Kong API Gateway
check_service "Kong Gateway (8000)" "curl -sf http://localhost:8000"

# Check Supabase Studio
check_service "Supabase Studio (3003)" "curl -sf http://localhost:3003"

# Check Kong Admin API
check_service "Kong Admin API (8001)" "curl -sf http://localhost:8001/status"

# Check active tenant runtimes
active_tenants=$(systemctl list-units 'supacloud-gotrue@*.service' --state=running --no-legend 2>/dev/null | wc -l)
if [[ "$active_tenants" -gt 0 ]]; then
    echo -e "${GREEN}✓${NC} Active tenants: $active_tenants"
else
    echo -e "${YELLOW}?${NC} No active tenant runtimes"
fi

# Check S3 Storage
if systemctl is-active --quiet rustfs 2>/dev/null; then
    check_service "RustFS (9000)" "curl -sf http://localhost:9000"
elif systemctl is-active --quiet garage 2>/dev/null; then
    check_service "Garage (9000)" "curl -sf http://localhost:9000"
elif systemctl is-active --quiet minio 2>/dev/null; then
    check_service "MinIO (9000)" "curl -sf http://localhost:9000"
else
    echo -e "${YELLOW}?${NC} S3 Storage (No service detected)"
fi

echo ""
echo "Check complete"

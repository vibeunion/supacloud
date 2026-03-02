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

echo "SupaCloud Health Check"
echo "=================="
echo ""

# Check Management API
check_service "Management API (9090)" "curl -sf http://localhost:9090/health"

# Check PostgreSQL
check_service "PostgreSQL (5432)" "pg_isready -h localhost -p 5432"

# Check Kong API Gateway
check_service "Kong Gateway (8000)" "curl -sf http://localhost:8000"

# Check Supabase Studio
check_service "Supabase Studio (3003)" "curl -sf http://localhost:3003"

# Check Nginx
check_service "Nginx" "nginx -t"

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

#!/bin/bash
# SupaCloud - Pre-start Recovery Script
# This script runs before services start to fix common issues
# Usage: pre_start_recovery.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_postmaster_pid_liveness() {
    local pg_data="${PGDATA:-/pg/data}"
    local pid_file="${pg_data}/postmaster.pid"

    [[ -f "$pid_file" ]] || return 0

    local pid
    pid=$(head -1 "$pid_file" 2>/dev/null || echo "")

    if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
        log_warn "Invalid PostgreSQL PID in $pid_file; leaving the file untouched"
        return
    fi

    if ps -p "$pid" -o pid= >/dev/null 2>&1; then
        log_info "PostgreSQL PID $pid is still running"
        return
    fi

    # The Management API unit intentionally has no CAP_KILL. A denied probe
    # must not become proof that PostgreSQL is dead; its owner handles recovery.
    log_warn "Unable to confirm PostgreSQL PID $pid; leaving $pid_file untouched for PostgreSQL/Patroni recovery"
}

fix_gotrue_search_path() {
    local pg_host="${PG_HOST:-localhost}"
    local pg_port="${PG_PORT:-5432}"
    local pg_user="${PG_USER:-postgres}"
    local pg_password="${PGPASSWORD:-${POSTGRES_PASSWORD:-postgres}}"
    
    log_info "Checking GoTrue search_path configuration..."
    
    local search_path
    search_path=$(PGPASSWORD="$pg_password" psql -h "$pg_host" -p "$pg_port" -U "$pg_user" -tAc \
        "SELECT rolconfig FROM pg_roles WHERE rolname = 'supabase_auth_admin'" 2>/dev/null || echo "")
    
    if [[ -z "$search_path" ]] || [[ "$search_path" != *"search_path"* ]]; then
        log_warn "supabase_auth_admin missing search_path, fixing..."
        PGPASSWORD="$pg_password" psql -h "$pg_host" -p "$pg_port" -U "$pg_user" -c \
            "ALTER ROLE supabase_auth_admin SET search_path TO auth, public;" 2>/dev/null || true
        log_info "GoTrue search_path configured"
    else
        log_info "GoTrue search_path already configured"
    fi
}

ensure_gateway_running() {
    local gateway_unit="${GATEWAY_UNIT:-supacloud-caddy}"
    if systemctl list-unit-files "${gateway_unit}.service" &>/dev/null || systemctl list-units "${gateway_unit}.service" &>/dev/null; then
        if systemctl is-active --quiet "$gateway_unit" 2>/dev/null; then
            log_info "$gateway_unit service already running"
        else
            log_warn "$gateway_unit service not running, starting..."
            systemctl reset-failed "$gateway_unit" 2>/dev/null || true
            systemctl start "$gateway_unit" 2>/dev/null || true
            if systemctl is-active --quiet "$gateway_unit" 2>/dev/null; then
                log_info "$gateway_unit service started"
            fi
        fi
    fi
}

restart_failed_tenants() {
    log_info "Checking for failed tenant services..."
    
    local failed_gotrue
    failed_gotrue=$(systemctl list-units 'supacloud-gotrue@*.service' --state=failed --no-legend 2>/dev/null || true)
    
    if [[ -n "$failed_gotrue" ]]; then
        log_warn "Found failed GoTrue services, attempting restart..."
        echo "$failed_gotrue" | while read -r line; do
            local unit
            unit=$(echo "$line" | awk '{print $1}')
            if [[ -n "$unit" ]]; then
                log_info "Resetting and restarting $unit"
                systemctl reset-failed "$unit" 2>/dev/null || true
                systemctl restart "$unit" 2>/dev/null || true
            fi
        done
    fi
    
    local failed_pgrst
    failed_pgrst=$(systemctl list-units 'supacloud-pgrst@*.service' --state=failed --no-legend 2>/dev/null || true)
    
    if [[ -n "$failed_pgrst" ]]; then
        log_warn "Found failed PostgREST services, attempting restart..."
        echo "$failed_pgrst" | while read -r line; do
            local unit
            unit=$(echo "$line" | awk '{print $1}')
            if [[ -n "$unit" ]]; then
                log_info "Resetting and restarting $unit"
                systemctl reset-failed "$unit" 2>/dev/null || true
                systemctl restart "$unit" 2>/dev/null || true
            fi
        done
    fi
    
    log_info "Tenant service recovery complete"
}

main() {
    echo "=========================================="
    echo "SupaCloud Pre-start Recovery"
    echo "=========================================="
    echo ""
    
    check_postmaster_pid_liveness
    fix_gotrue_search_path
    ensure_gateway_running
    # Container recovery stays outside this sandbox. Realtime has a dedicated
    # systemd unit, and Imaginary uses the installer-managed restart policy.
    # Container CLIs require mount-family syscalls that this unit denies.
    restart_failed_tenants
    
    echo ""
    echo "=========================================="
    log_info "Pre-start recovery complete"
    echo "=========================================="
}

main "$@"

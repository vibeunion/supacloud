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

fix_stale_postmaster_pid() {
    local pg_data="${PGDATA:-/pg/data}"
    local pid_file="${pg_data}/postmaster.pid"
    
    if [[ -f "$pid_file" ]]; then
        local pid
        pid=$(head -1 "$pid_file" 2>/dev/null || echo "")
        
        if [[ -n "$pid" ]]; then
            if ! kill -0 "$pid" 2>/dev/null; then
                log_warn "Found stale postmaster.pid (PID: $pid), removing..."
                rm -f "$pid_file"
                log_info "Stale PID file removed"
            else
                log_info "PostgreSQL PID $pid is still running"
            fi
        fi
    fi
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

ensure_kong_running() {
    if systemctl list-unit-files kong.service &>/dev/null || systemctl list-units kong.service &>/dev/null; then
        if systemctl is-active --quiet kong 2>/dev/null; then
            log_info "Kong service already running"
        else
            log_warn "Kong service not running, starting..."
            systemctl start kong 2>/dev/null || true
            if systemctl is-active --quiet kong 2>/dev/null; then
                log_info "Kong service started"
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

ensure_service_containers_running() {
    log_info "Checking service containers (Imaginary, Realtime)..."

    local RUNTIME="podman"
    command -v podman &>/dev/null || RUNTIME="docker"

    for container in supacloud-imaginary supacloud-realtime; do
        local status
        status=$($RUNTIME ps -a --filter "name=${container}" --format '{{.Status}}' 2>/dev/null || echo "")

        if [[ -n "$status" ]]; then
            if [[ "$status" != *"Up"* ]] && [[ "$status" != *"Running"* ]]; then
                log_warn "${container} not running, starting..."
                $RUNTIME start "${container}" 2>/dev/null || true
            else
                log_info "${container} already running"
            fi
        fi
    done
}

# ── Edge Runtime Zombie Killer ──────────────────────────────────────
# SO_REUSEPORT allows multiple processes to bind the same port.
# If an old bun runtime survives a restart/deploy, requests get split
# 50/50 between old and new code — causing phantom failures.
# This function kills ALL processes listening on port 9000 so that
# only the newly started runtime claims the port.
kill_edge_runtime_zombies() {
    local EDGE_PORT="${EDGE_RUNTIME_PORT:-9000}"
    log_info "Checking for stale Edge Runtime processes on port ${EDGE_PORT}..."
    
    local stale_pids
    stale_pids=$(lsof -iTCP:${EDGE_PORT} -sTCP:LISTEN -t 2>/dev/null || true)
    
    if [[ -n "$stale_pids" ]]; then
        local count=0
        for pid in $stale_pids; do
            local cmd
            cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
            log_warn "Killing stale Edge Runtime process: pid=$pid cmd=$cmd"
            kill -9 "$pid" 2>/dev/null || true
            count=$((count + 1))
        done
        log_info "Killed $count stale Edge Runtime process(es) on port ${EDGE_PORT}"
    else
        log_info "No stale Edge Runtime processes found"
    fi
}

main() {
    echo "=========================================="
    echo "SupaCloud Pre-start Recovery"
    echo "=========================================="
    echo ""
    
    fix_stale_postmaster_pid
    fix_gotrue_search_path
    kill_edge_runtime_zombies
    ensure_kong_running
    ensure_service_containers_running
    restart_failed_tenants
    
    echo ""
    echo "=========================================="
    log_info "Pre-start recovery complete"
    echo "=========================================="
}

main "$@"

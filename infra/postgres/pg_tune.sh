#!/bin/bash
# SupaCloud - PostgreSQL 18 Performance Tuning Script
# Purpose: Dynamically calculate and apply PG18 best-practice parameters based on server memory
# Usage: sudo bash infra/postgres/pg_tune.sh [--pg-version 18] [--dry-run]
# Mechanism: Write to postgresql.auto.conf via ALTER SYSTEM, effective after restart
#            (Certain parameters support hot reloading via SELECT pg_reload_conf(); the script distinguishes them)

set -euo pipefail

LOG_PREFIX="[pg-tune]"
DRY_RUN=false
PG_VERSION="${PG_VERSION:-18}"
PG_HOST="${PG_HOST:-/var/run/postgresql}"   # Prefer unix socket
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-postgres}"
PSQL_OPTS="-h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d postgres"

log()  { echo "${LOG_PREFIX} $*"; }
warn() { echo "${LOG_PREFIX} [WARN]  $*" >&2; }
info() { echo "${LOG_PREFIX} [INFO]  $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)      DRY_RUN=true;       shift ;;
    --pg-version)   PG_VERSION="$2";    shift 2 ;;
    --pg-host)      PG_HOST="$2";       PSQL_OPTS="-h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d postgres"; shift 2 ;;
    *) warn "Unknown parameter: $1"; shift ;;
  esac
done

run_sql() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "  [DRY-RUN] psql ${PSQL_OPTS} -c \"$1\""
  else
    psql ${PSQL_OPTS} -t -A -c "$1"
  fi
}

alter_system() {
  local param="$1"
  local value="$2"
  local hot_reload="${3:-false}"   # Whether hot reloading without restart is supported

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "  [DRY-RUN] ALTER SYSTEM SET ${param} = '${value}';"
  else
    psql ${PSQL_OPTS} -c "ALTER SYSTEM SET ${param} = '${value}';" > /dev/null
  fi

  if [[ "${hot_reload}" == "true" ]]; then
    log "  ${param} = ${value}  (hot reloaded)"
  else
    log "  ${param} = ${value}  (restart required)"
  fi
}

# ── Detect server memory ──────────────────────────────────────────────────
TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_MEM_GB=$(awk "BEGIN {printf \"%.0f\", ${TOTAL_MEM_KB}/1024/1024}")

log "Detected server memory: ${TOTAL_MEM_GB}GB"

# ── Detect whether disk is SSD (affects effective_io_concurrency) ─────────
IS_SSD=false
for disk in /sys/block/sd* /sys/block/nvme*; do
  [ -f "${disk}/queue/rotational" ] || continue
  if [[ "$(cat "${disk}/queue/rotational")" == "0" ]]; then
    IS_SSD=true
    break
  fi
done
log "Storage type: $(${IS_SSD} && echo 'SSD' || echo 'HDD/Unknown')"

# ── Detect io_uring kernel support ────────────────────────────────────────
KERNEL_VER=$(uname -r | cut -d. -f1-2 | tr -d '.')
IO_URING_SUPPORTED=false
if [[ ${KERNEL_VER} -ge 54 ]]; then
  IO_URING_SUPPORTED=true
fi
log "Kernel version: $(uname -r), io_uring support: $(${IO_URING_SUPPORTED} && echo 'yes' || echo 'no (requires >=5.4)')"

# ── Dynamically calculate parameter values ────────────────────────────────

# shared_buffers: Reduce to 10%-15% on small machines to conserve memory for Caddy gateway and JuiceFS OSM cache
SHARED_BUFFERS_GB=$(awk "BEGIN {printf \"%.0f\", ${TOTAL_MEM_GB} * 0.12}")
[[ ${SHARED_BUFFERS_GB} -lt 1 ]] && SHARED_BUFFERS_GB=1
SHARED_BUFFERS="256MB" # Conservative setting on micro instances

# effective_cache_size: 50% of system memory (reserved for page cache)
EFFECTIVE_CACHE_SIZE_GB=$(awk "BEGIN {printf \"%.0f\", ${TOTAL_MEM_GB} * 0.50}")
[[ ${EFFECTIVE_CACHE_SIZE_GB} -lt 1 ]] && EFFECTIVE_CACHE_SIZE_GB=1
EFFECTIVE_CACHE_SIZE="${EFFECTIVE_CACHE_SIZE_GB}GB"

# work_mem: Conservatively throttled to protect against 100-tenant concurrency cascades (1MB)
WORK_MEM="1MB"

# maintenance_work_mem: Used for VACUUM/ANALYZE/CREATE INDEX, scaled conservatively
MAINTENANCE_WORK_MEM="32MB"

# effective_io_concurrency: 200 for SSD, 2 for HDD
if ${IS_SSD}; then
  EFF_IO_CONCURRENCY=200
  MAINT_IO_CONCURRENCY=50
else
  EFF_IO_CONCURRENCY=2
  MAINT_IO_CONCURRENCY=2
fi

log ""
log "════════════════════════════════════════════════════"
log "  Calculation Result Preview"
log "════════════════════════════════════════════════════"
log "  shared_buffers              = ${SHARED_BUFFERS}"
log "  effective_cache_size        = ${EFFECTIVE_CACHE_SIZE}"
log "  work_mem                    = ${WORK_MEM}"
log "  maintenance_work_mem        = ${MAINTENANCE_WORK_MEM}"
log "  effective_io_concurrency    = ${EFF_IO_CONCURRENCY}"
log "  maintenance_io_concurrency  = ${MAINT_IO_CONCURRENCY}"
if ${IO_URING_SUPPORTED} && [[ "${PG_VERSION}" -ge 18 ]]; then
  log "  io_method                   = io_uring  (PG18 + kernel>=5.4)"
  log "  io_combine_limit            = 512kB"
fi
log "════════════════════════════════════════════════════"
log ""

if [[ "${DRY_RUN}" == "true" ]]; then
  warn "Current mode is --dry-run, commands will not actually be executed"
fi

# ── Apply parameters ──────────────────────────────────────────────────────
log "Applying memory parameters..."
alter_system "shared_buffers"           "${SHARED_BUFFERS}"             false
alter_system "effective_cache_size"     "${EFFECTIVE_CACHE_SIZE}"       true
alter_system "work_mem"                 "${WORK_MEM}"                   true
alter_system "maintenance_work_mem"     "${MAINTENANCE_WORK_MEM}"       true

log "Applying I/O concurrency parameters..."
alter_system "effective_io_concurrency"   "${EFF_IO_CONCURRENCY}"       true
alter_system "maintenance_io_concurrency" "${MAINT_IO_CONCURRENCY}"     true

# PG18 specific: asynchronous IO
if ${IO_URING_SUPPORTED} && [[ "${PG_VERSION}" -ge 18 ]]; then
  log "Applying PG18 async IO parameters..."
  alter_system "io_method"         "io_uring" false
  alter_system "io_combine_limit"  "512kB"    false
else
  warn "Skipping io_uring: requires PostgreSQL >= 18 and kernel >= 5.4"
fi

log "Applying WAL and checkpoint parameters..."
alter_system "wal_compression"          "zstd"    true   # PG17+, compress WAL to reduce I/O
alter_system "checkpoint_completion_target" "0.9" true   # Spread checkpoint I/O
alter_system "max_wal_size"             "4GB"     true
alter_system "min_wal_size"             "512MB"   true

log "Applying query planner parameters..."
alter_system "random_page_cost"         "$(${IS_SSD} && echo '1.1' || echo '4.0')"  true
alter_system "default_statistics_target" "100"   true    # More accurate statistics

log "Applying connection and logging parameters..."
alter_system "max_connections"          "200"              false  # Adjust based on real demand
alter_system "log_min_duration_statement" "1000"           true   # Log slow queries >1s
alter_system "log_connections"          "off"              true   # Align with Supabase 2026 default, reducing log noise

# ── Hot reload (effective immediately for supported parameters) ───────────
if [[ "${DRY_RUN}" == "false" ]]; then
  log ""
  log "Executing pg_reload_conf() to apply hot-reloadable parameters..."
  run_sql "SELECT pg_reload_conf();" > /dev/null
  log "  ✓ Hot reload complete"
fi

# ── Verify current values ─────────────────────────────────────────────────
if [[ "${DRY_RUN}" == "false" ]]; then
  log ""
  log "Currently effective parameters (some parameters take effect after restart):"
  psql ${PSQL_OPTS} -c "
    SELECT name,
           setting || ' ' || COALESCE(unit,'') AS current_value,
           source
    FROM pg_settings
    WHERE name IN (
      'shared_buffers','effective_cache_size','work_mem',
      'maintenance_work_mem','effective_io_concurrency',
      'maintenance_io_concurrency','io_method','io_combine_limit',
      'wal_compression','random_page_cost','max_connections','log_connections'
    )
    ORDER BY name;
  "
fi

# ── Final notes ───────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
echo "  PostgreSQL tuning complete"
echo "════════════════════════════════════════════════════"
echo ""
echo "  Parameters requiring restart to take effect:"
echo "    shared_buffers / max_connections"
if ${IO_URING_SUPPORTED} && [[ "${PG_VERSION}" -ge 18 ]]; then
  echo "    io_method / io_combine_limit"
fi
echo ""
echo "  Restart command (Pigsty environment):"
echo "    systemctl restart patroni   # or"
echo "    pg_ctl restart -D /pg/data"
echo ""
echo "  Verify after restart:"
echo "    psql -c \"SHOW io_method;\""
echo "    psql -c \"SHOW shared_buffers;\""
echo ""

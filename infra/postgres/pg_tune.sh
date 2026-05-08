#!/bin/bash
# SupaCloud - PostgreSQL 18 性能调优脚本
# 用途: 根据服务器内存动态计算并应用 PG18 最佳实践参数
# 用法: sudo bash infra/postgres/pg_tune.sh [--pg-version 18] [--dry-run]
# 原理: 通过 ALTER SYSTEM 写入 postgresql.auto.conf，重启后生效
#       (部分参数支持 SELECT pg_reload_conf() 热重载，脚本会自动区分)

set -euo pipefail

LOG_PREFIX="[pg-tune]"
DRY_RUN=false
PG_VERSION="${PG_VERSION:-18}"
PG_HOST="${PG_HOST:-/var/run/postgresql}"   # 优先 unix socket
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
    *) warn "未知参数: $1"; shift ;;
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
  local hot_reload="${3:-false}"   # 是否支持不重启热重载

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "  [DRY-RUN] ALTER SYSTEM SET ${param} = '${value}';"
  else
    psql ${PSQL_OPTS} -c "ALTER SYSTEM SET ${param} = '${value}';" > /dev/null
  fi

  if [[ "${hot_reload}" == "true" ]]; then
    log "  ${param} = ${value}  (热重载生效)"
  else
    log "  ${param} = ${value}  (需重启)"
  fi
}

# ── 检测服务器内存 ─────────────────────────────────────────────────────────
TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_MEM_GB=$(awk "BEGIN {printf \"%.0f\", ${TOTAL_MEM_KB}/1024/1024}")

log "检测到服务器内存: ${TOTAL_MEM_GB}GB"

# ── 检测是否为 SSD（影响 effective_io_concurrency）──────────────────────────
IS_SSD=false
for disk in /sys/block/sd* /sys/block/nvme*; do
  [ -f "${disk}/queue/rotational" ] || continue
  if [[ "$(cat "${disk}/queue/rotational")" == "0" ]]; then
    IS_SSD=true
    break
  fi
done
log "存储类型: $(${IS_SSD} && echo 'SSD' || echo 'HDD/未知')"

# ── 检测 io_uring 内核支持 ──────────────────────────────────────────────────
KERNEL_VER=$(uname -r | cut -d. -f1-2 | tr -d '.')
IO_URING_SUPPORTED=false
if [[ ${KERNEL_VER} -ge 54 ]]; then
  IO_URING_SUPPORTED=true
fi
log "内核版本: $(uname -r)，io_uring 支持: $(${IO_URING_SUPPORTED} && echo '是' || echo '否（需>=5.4）')"

# ── 动态计算各参数值 ─────────────────────────────────────────────────────────

# shared_buffers: 在微小机型上缩减至 10%-15%，尽量腾出内存给 Kong 和 JuiceFS OSM 缓存
SHARED_BUFFERS_GB=$(awk "BEGIN {printf \"%.0f\", ${TOTAL_MEM_GB} * 0.12}")
[[ ${SHARED_BUFFERS_GB} -lt 1 ]] && SHARED_BUFFERS_GB=1
SHARED_BUFFERS="256MB" # 强制在微型机器上保守设定

# effective_cache_size: 系统内存的 50%（预留给页面缓存）
EFFECTIVE_CACHE_SIZE_GB=$(awk "BEGIN {printf \"%.0f\", ${TOTAL_MEM_GB} * 0.50}")
[[ ${EFFECTIVE_CACHE_SIZE_GB} -lt 1 ]] && EFFECTIVE_CACHE_SIZE_GB=1
EFFECTIVE_CACHE_SIZE="${EFFECTIVE_CACHE_SIZE_GB}GB"

# work_mem: 保守压缩以防御 100 租户高并发雪崩，锁死在极小数值 (1MB)
WORK_MEM="1MB"

# maintenance_work_mem: 用于 VACUUM/ANALYZE/CREATE INDEX，适当降级 
MAINTENANCE_WORK_MEM="32MB"

# effective_io_concurrency: SSD 用 200，HDD 用 2
if ${IS_SSD}; then
  EFF_IO_CONCURRENCY=200
  MAINT_IO_CONCURRENCY=50
else
  EFF_IO_CONCURRENCY=2
  MAINT_IO_CONCURRENCY=2
fi

log ""
log "════════════════════════════════════════════════════"
log "  计算结果预览"
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
  warn "当前为 --dry-run 模式，以下命令不会实际执行"
fi

# ── 应用参数 ──────────────────────────────────────────────────────────────────
log "应用内存相关参数..."
alter_system "shared_buffers"           "${SHARED_BUFFERS}"             false
alter_system "effective_cache_size"     "${EFFECTIVE_CACHE_SIZE}"       true
alter_system "work_mem"                 "${WORK_MEM}"                   true
alter_system "maintenance_work_mem"     "${MAINTENANCE_WORK_MEM}"       true

log "应用 I/O 并发参数..."
alter_system "effective_io_concurrency"   "${EFF_IO_CONCURRENCY}"       true
alter_system "maintenance_io_concurrency" "${MAINT_IO_CONCURRENCY}"     true

# PG18 专属：异步 IO
if ${IO_URING_SUPPORTED} && [[ "${PG_VERSION}" -ge 18 ]]; then
  log "应用 PG18 异步 IO 参数..."
  alter_system "io_method"         "io_uring" false
  alter_system "io_combine_limit"  "512kB"    false
else
  warn "跳过 io_uring：需要 PostgreSQL >= 18 且内核 >= 5.4"
fi

log "应用 WAL 及检查点参数..."
alter_system "wal_compression"          "zstd"    true   # PG17+，压缩 WAL 减少 I/O
alter_system "checkpoint_completion_target" "0.9" true   # 分散 checkpoint I/O
alter_system "max_wal_size"             "4GB"     true
alter_system "min_wal_size"             "512MB"   true

log "应用查询规划器参数..."
alter_system "random_page_cost"         "$(${IS_SSD} && echo '1.1' || echo '4.0')"  true
alter_system "default_statistics_target" "100"   true    # 更精确的统计信息

log "应用连接及日志参数..."
alter_system "max_connections"          "200"              false  # 根据实际需求调整
alter_system "log_min_duration_statement" "1000"           true   # 记录 >1s 的慢查询

# ── 热重载（对支持热重载的参数立即生效）──────────────────────────────────────
if [[ "${DRY_RUN}" == "false" ]]; then
  log ""
  log "执行 pg_reload_conf() 使热重载参数立即生效..."
  run_sql "SELECT pg_reload_conf();" > /dev/null
  log "  ✓ 热重载完成"
fi

# ── 输出当前值验证 ──────────────────────────────────────────────────────────
if [[ "${DRY_RUN}" == "false" ]]; then
  log ""
  log "当前生效参数（部分参数重启后才变更）:"
  psql ${PSQL_OPTS} -c "
    SELECT name,
           setting || ' ' || COALESCE(unit,'') AS current_value,
           source
    FROM pg_settings
    WHERE name IN (
      'shared_buffers','effective_cache_size','work_mem',
      'maintenance_work_mem','effective_io_concurrency',
      'maintenance_io_concurrency','io_method','io_combine_limit',
      'wal_compression','random_page_cost','max_connections'
    )
    ORDER BY name;
  "
fi

# ── 最终提示 ────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
echo "  PostgreSQL 调优完成"
echo "════════════════════════════════════════════════════"
echo ""
echo "  需要重启才能生效的参数:"
echo "    shared_buffers / max_connections"
if ${IO_URING_SUPPORTED} && [[ "${PG_VERSION}" -ge 18 ]]; then
  echo "    io_method / io_combine_limit"
fi
echo ""
echo "  重启命令（Pigsty 环境）:"
echo "    systemctl restart patroni   # 或"
echo "    pg_ctl restart -D /pg/data"
echo ""
echo "  重启后验证:"
echo "    psql -c \"SHOW io_method;\""
echo "    psql -c \"SHOW shared_buffers;\""
echo ""

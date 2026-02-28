#!/bin/bash
# SupaCloud - OpenResty Auto SSL 一键安装脚本
# 平台: Rocky Linux 9 / RHEL 9
# 用途: 安装 OpenResty + lua-resty-auto-ssl + pgmoon，替代 Pigsty Nginx
# 用法: sudo bash infra/openresty/setup.sh [--pg-password <password>] [--pg-host <host>]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_PREFIX="[openresty-setup]"

# ── 参数 ────────────────────────────────────────────────────────────────────
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"
PG_DATABASE="${PG_DATABASE:-postgres}"
PG_PASSWORD="${PG_PASSWORD:-}"    # 安装时会提示输入

OPENRESTY_CONF_DIR="/usr/local/openresty/nginx/conf"
ADAPTER_INSTALL_DIR="/usr/local/openresty/lualib/resty/auto-ssl/storage_adapters"
CERT_DIR="/etc/resty-auto-ssl"
FALLBACK_CERT_DIR="/etc/ssl"

log()  { echo "${LOG_PREFIX} $*"; }
warn() { echo "${LOG_PREFIX} [WARN] $*" >&2; }
die()  { echo "${LOG_PREFIX} [ERROR] $*" >&2; exit 1; }

# 解析命令行参数
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pg-password) PG_PASSWORD="$2"; shift 2 ;;
    --pg-host)     PG_HOST="$2";     shift 2 ;;
    --pg-port)     PG_PORT="$2";     shift 2 ;;
    --pg-database) PG_DATABASE="$2"; shift 2 ;;
    *) warn "未知参数: $1"; shift ;;
  esac
done

# 确保 root 权限
[[ $EUID -eq 0 ]] || die "请以 root 身份运行此脚本（sudo bash setup.sh）"

# 如果没有提供密码，交互式询问
if [[ -z "${PG_PASSWORD}" ]]; then
  read -rsp "${LOG_PREFIX} 请输入 autossl 数据库用户密码: " PG_PASSWORD
  echo
fi

# ── Step 1: 添加 OpenResty 官方 yum 源 ──────────────────────────────────────
log "Step 1/7: 配置 OpenResty yum 源..."
cat > /etc/yum.repos.d/openresty.repo << 'EOF'
[openresty]
name=Official OpenResty Open Source Repository for Enterprise Linux
baseurl=https://openresty.org/package/rhel/$releasever/$basearch
skip_if_unavailable=False
gpgcheck=1
gpgkey=https://openresty.org/package/pubkey.gpg
enabled=1
EOF

# ── Step 2: 安装 OpenResty ───────────────────────────────────────────────────
log "Step 2/7: 安装 OpenResty..."
dnf install -y openresty openresty-opm

# ── Step 3: 安装 Lua 依赖 ───────────────────────────────────────────────────
log "Step 3/7: 安装 pgmoon 和 lua-resty-auto-ssl..."
opm get leafo/pgmoon
opm get auto-ssl/lua-resty-auto-ssl

# ── Step 4: 部署 PostgreSQL 存储适配器 ──────────────────────────────────────
log "Step 4/7: 部署 PostgreSQL 存储适配器..."
mkdir -p "${ADAPTER_INSTALL_DIR}"
cp "${SCRIPT_DIR}/storage_adapters/postgres.lua" "${ADAPTER_INSTALL_DIR}/postgres.lua"
log "  适配器已安装到: ${ADAPTER_INSTALL_DIR}/postgres.lua"

# ── Step 5: 创建证书目录和 fallback 自签名证书 ──────────────────────────────
log "Step 5/7: 创建证书目录和 fallback 自签名证书..."
mkdir -p "${CERT_DIR}"
chown nobody:nobody "${CERT_DIR}"
chmod 700 "${CERT_DIR}"

if [[ ! -f "${FALLBACK_CERT_DIR}/resty-auto-ssl-fallback.crt" ]]; then
  openssl req -new -newkey rsa:2048 -days 3650 -nodes -x509 \
    -subj '/CN=sni-support-required-for-valid-ssl' \
    -keyout "${FALLBACK_CERT_DIR}/resty-auto-ssl-fallback.key" \
    -out    "${FALLBACK_CERT_DIR}/resty-auto-ssl-fallback.crt"
  log "  Fallback 证书已生成: ${FALLBACK_CERT_DIR}/resty-auto-ssl-fallback.crt"
else
  log "  Fallback 证书已存在，跳过生成"
fi

# ── Step 6: 部署 nginx.conf（如果尚不存在）────────────────────────────────
log "Step 6/7: 部署 OpenResty 配置..."
if [[ -f "${OPENRESTY_CONF_DIR}/nginx.conf" && ! -f "${OPENRESTY_CONF_DIR}/nginx.conf.orig" ]]; then
  cp "${OPENRESTY_CONF_DIR}/nginx.conf" "${OPENRESTY_CONF_DIR}/nginx.conf.orig"
  log "  原配置已备份到 nginx.conf.orig"
fi

# 将密码注入配置模板后写入目标位置
sed "s|CHANGE_ME_STRONG_PASSWORD|${PG_PASSWORD}|g" \
  "${SCRIPT_DIR}/nginx.conf" > "${OPENRESTY_CONF_DIR}/nginx.conf"
log "  nginx.conf 已写入: ${OPENRESTY_CONF_DIR}/nginx.conf"
warn "  请修改 ${OPENRESTY_CONF_DIR}/nginx.conf 中的域名（YOUR_DOMAIN_HERE）！"

# ── Step 7: 数据库迁移 ──────────────────────────────────────────────────────
log "Step 7/7: 执行数据库迁移..."
if command -v psql &>/dev/null; then
  # 先用 postgres 超级用户建表和角色
  PGPASSWORD="" psql -h "${PG_HOST}" -p "${PG_PORT}" -U postgres \
    -d "${PG_DATABASE}" \
    -f "${SCRIPT_DIR}/migrations/001_autossl_schema.sql" || warn "迁移失败，请手动执行 migrations/001_autossl_schema.sql"

  # 更新 autossl 角色密码为用户指定的密码
  PGPASSWORD="" psql -h "${PG_HOST}" -p "${PG_PORT}" -U postgres \
    -d "${PG_DATABASE}" \
    -c "ALTER ROLE autossl PASSWORD '${PG_PASSWORD}';" || warn "无法更新角色密码，请手动执行"

  log "  数据库迁移完成"
else
  warn "psql 未找到，请手动执行: psql -U postgres -f infra/openresty/migrations/001_autossl_schema.sql"
fi

# ── 配置 systemd ─────────────────────────────────────────────────────────────
log "配置 systemd openresty.service..."
# Pigsty 安装的 nginx 服务可能占用 80/443，先停止
if systemctl is-active --quiet nginx 2>/dev/null; then
  systemctl stop nginx
  systemctl disable nginx
  log "  已停止并禁用 nginx.service"
fi

systemctl enable openresty
systemctl daemon-reload

# ── 验证配置语法 ─────────────────────────────────────────────────────────────
log "验证 OpenResty 配置语法..."
if openresty -t 2>&1; then
  log "  配置语法正确 ✓"
else
  warn "配置语法有错误，请检查 ${OPENRESTY_CONF_DIR}/nginx.conf"
fi

# ── 完成提示 ─────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  OpenResty + lua-resty-auto-ssl + PostgreSQL 安装完成"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "  【必须操作】"
echo "  1. 编辑 ${OPENRESTY_CONF_DIR}/nginx.conf"
echo "     替换所有 YOUR_DOMAIN_HERE 为实际域名"
echo ""
echo "  2. 在 pigsty.yml 中设置："
echo "     nginx_enabled: false"
echo "     nginx_exporter_enabled: false"
echo ""
echo "  3. 启动服务："
echo "     systemctl start openresty"
echo ""
echo "  4. 验证（首次会触发证书申请，约 5-30 秒）："
echo "     curl -I https://YOUR_DOMAIN_HERE"
echo ""
echo "  5. 确认证书已写入 PostgreSQL："
echo "     psql -U autossl postgres -c \"SELECT key, updated_at FROM autossl.certificates;\""
echo ""

#!/bin/bash
# SupaCloud - Angie (Nginx Fork) SSL 自动化安装脚本
# 平台: OpenCloudOS 9 / RHEL 9 / Rocky Linux 9
# 用途: 安装 Angie + http_acme 模块，替代 OpenResty + lua-resty-auto-ssl
#
# 用法:
#   sudo bash setup.sh --studio-domain <domain> --api-domain <domain>

set -euo pipefail

LOG_PREFIX="[angie-setup]"
log()  { echo "${LOG_PREFIX} $*"; }
warn() { echo "${LOG_PREFIX} [WARN] $*" >&2; }
die()  { echo "${LOG_PREFIX} [ERROR] $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUDIO_DOMAIN="${STUDIO_DOMAIN:-}"
API_DOMAIN="${API_DOMAIN:-}"

# ── 命令行参数 ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --studio-domain) STUDIO_DOMAIN="$2"; shift 2 ;;
    --api-domain)    API_DOMAIN="$2";    shift 2 ;;
    *) warn "未知参数: $1"; shift ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请以 root 身份运行此脚本（sudo bash setup.sh）"

# ── Step 1: 配置 Angie 仓库 ──────────────────────────────────────────────────
log "Step 1/4: 配置 Angie 官方仓库..."
if command -v dnf &>/dev/null; then
    # 安装 Angie 的 RPM 仓库配置包
    dnf install -y https://download.angie.software/angie/el/9/x86_64/angie-repo-1.0-1.el9.noarch.rpm || true
    dnf makecache
else
    die "当前仅支持基于 DNF (RHEL/CentOS 9 系列) 的发行版"
fi

# ── Step 2: 安装 Angie 和 ACME 模块 ─────────────────────────────────────────
log "Step 2/4: 安装 Angie 核心及 ACME 模块..."
dnf install -y angie angie-module-http-acme

# ── Step 3: 部署 Angie 配置文件 ─────────────────────────────────────────────
log "Step 3/4: 部署 Angie 配置文件..."
BACKUP_TIME=$(date +%Y%m%d%H%M%S)
[[ -f /etc/angie/angie.conf ]] && mv /etc/angie/angie.conf "/etc/angie/angie.conf.bak.${BACKUP_TIME}"

# 替换域名并写入配置
sed \
  -e "s|YOUR_STUDIO_DOMAIN|${STUDIO_DOMAIN}|g" \
  -e "s|YOUR_API_DOMAIN|${API_DOMAIN}|g" \
  "${SCRIPT_DIR}/angie.conf" > /etc/angie/angie.conf

mkdir -p /etc/angie/http.d/
log "  配置文件已写入: /etc/angie/angie.conf"

# ── Step 4: 服务管理 ────────────────────────────────────────────────────────
log "Step 4/4: 配置并启动 Angie 服务..."

# 停失并禁用旧的 OpenResty (如果存在)
if systemctl is-active --quiet openresty 2>/dev/null; then
    systemctl stop openresty
    systemctl disable openresty
    log "  已停止并禁用 openresty.service"
fi

systemctl enable angie
systemctl start angie

# 验证配置
angie -t && log "  Angie 配置验证通过 ✓" || warn "配置验证失败，请手动检查"

log "=== Angie 安装与配置完成 ==="
echo ""
echo "  访问地址:"
echo "    Studio: https://${STUDIO_DOMAIN}"
echo "    API:    https://${API_DOMAIN}"
echo ""

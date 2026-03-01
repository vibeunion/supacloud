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
    # RHEL / CentOS / Rocky Linux 系列
    dnf install -y https://download.angie.software/angie/el/9/x86_64/stable/angie-repo-1.0-1.el9.noarch.rpm || true
    dnf makecache
elif command -v apt-get &>/dev/null; then
    # Debian / Ubuntu 系列
    apt-get update
    apt-get install -y ca-certificates curl gnupg2 lsb-release
    
    # 导入签名密钥
    curl -fsSL https://angie.software/keys/angie-signing.gpg | gpg --dearmor -o /etc/apt/trusted.gpg.d/angie-signing.gpg --yes
    
    # 添加仓库源 (动态识别发行版代号)
    OS_ID=$(. /etc/os-release && echo "$ID")
    OS_CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
    echo "deb https://download.angie.software/angie/${OS_ID}/${OS_CODENAME} main" > /etc/apt/sources.list.d/angie.list
    
    apt-get update
else
    die "当前暂不支持您的操作系统发行版 (仅限 RHEL/DNF 或 Debian/Ubuntu 系列)"
fi

# ── Step 2: 安装 Angie 和 ACME 模块 ─────────────────────────────────────────
log "Step 2/4: 安装 Angie 核心及 ACME 模块..."
if command -v dnf &>/dev/null; then
    dnf install -y angie angie-module-http-acme
elif command -v apt-get &>/dev/null; then
    apt-get install -y angie angie-module-http-acme
fi

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

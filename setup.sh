#!/bin/bash
# ============================================================
# SupaCloud 简易安装入口脚本
#
# 使用方法:
#   curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh | sudo bash
# ============================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

# 检查 root 权限
if [[ $EUID -ne 0 ]]; then
    log_error "请使用 root 用户运行此脚本"
    exit 1
fi

# 检查并安装基础依赖
install_base_deps() {
    log_step "检查基础依赖..."
    if command -v git &>/dev/null && command -v curl &>/dev/null; then
        log_info "基础依赖已就绪"
        return
    fi

    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        case "$ID" in
            rocky|almalinux|centos|rhel)
                yum install -y git curl
                ;;
            ubuntu|debian)
                apt-get update && apt-get install -y git curl
                ;;
            *)
                log_warn "未识别的系统，请确保已安装 git 和 curl"
                ;;
        esac
    fi
}

# 克隆仓库
clone_repo() {
    INSTALL_DIR="/opt/supacloud"
    if [[ -d "$INSTALL_DIR" ]]; then
        log_info "目标目录 $INSTALL_DIR 已存在，跳过克隆"
        cd "$INSTALL_DIR"
    else
        log_step "克隆 SupaCloud 仓库到 $INSTALL_DIR (使用加速)..."
        git clone https://gh-proxy.net/https://github.com/zuohuadong/supacloud.git "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi
}

# ⚠️ 锁定 OpenSSL 版本，防止升级导致系统崩溃
# 必须在运行 install.sh 之前执行
lock_openssl() {
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        case "$ID" in
            opencloudos|tencentos)
                log_warn "检测到 $PRETTY_NAME，锁定 OpenSSL 版本..."
                log_warn "防止 Pigsty bootstrap 升级 OpenSSL 导致 sshd/dnf 崩溃"
                
                # 在 dnf.conf 中排除 OpenSSL 相关包
                if ! grep -q "exclude=openssl" /etc/dnf/dnf.conf 2>/dev/null; then
                    echo "exclude=openssl* libssl* libcrypto*" >> /etc/dnf/dnf.conf
                    log_info "已在 /etc/dnf/dnf.conf 中排除 OpenSSL 包"
                fi
                
                # 记录当前 OpenSSL 版本
                OPENSSL_VER=$(openssl version 2>/dev/null | awk '{print $2}')
                log_info "当前 OpenSSL 版本: $OPENSSL_VER (已锁定)"
                ;;
        esac
    fi
}

# 生成配置
generate_config() {
    log_step "生成安装配置..."
    
    CONFIG_FILE="config.env"
    if [[ -f "$CONFIG_FILE" ]]; then
        log_info "配置文件已存在，将使用现有配置"
        return
    fi

    # 自动获取内网 IP
    INTERNAL_IP=$(hostname -I | awk '{print $1}')
    
    # 交互式获取域名
    echo ""
    echo -e "${YELLOW}请输入您的 Supabase API 域名 (必需)${NC}"
    echo -e "${BLUE}该域名将用于 API, Auth, Realtime 等访问 (例如: supa.example.com)${NC}"
    read -p "域名: " SUPABASE_PUBLIC_DOMAIN
    
    while [[ -z "$SUPABASE_PUBLIC_DOMAIN" ]]; do
        log_error "域名不能为空，请重新输入"
        read -p "域名: " SUPABASE_PUBLIC_DOMAIN
    done

    # 自动生成强密码
    DB_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)
    STUDIO_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)
    GRAFANA_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)

    # 写入配置
    cat > "$CONFIG_FILE" << EOF
#!/bin/bash
# SupaCloud 自动生成的配置文件

INTERNAL_IP="${INTERNAL_IP}"
SUPABASE_PUBLIC_DOMAIN="${SUPABASE_PUBLIC_DOMAIN}"
SUPABASE_STUDIO_DOMAIN="studio.${SUPABASE_PUBLIC_DOMAIN}"

DASHBOARD_USERNAME="admin"
DASHBOARD_PASSWORD="${STUDIO_PASS}"
POSTGRES_PASSWORD="${DB_PASS}"
GRAFANA_PASSWORD="${GRAFANA_PASS}"

SWAP_SIZE_GB=4
PG_VERSION=18
S3_STORAGE_TYPE="garage"
EDGE_RUNTIME="deno"
ENABLE_ANALYTICS=true
ANALYTICS_BACKEND="postgres"
EOF

    log_info "配置已生成并保存到 $CONFIG_FILE"
    echo -e "----------------------------------------"
    echo -e "Studio 用户名: admin"
    echo -e "Studio 密码:   ${STUDIO_PASS}"
    echo -e "数据库密码:    ${DB_PASS}"
    echo -e "----------------------------------------"
    log_warn "请务必记录以上密码！安装完成后也可以在 /etc/supabase/supacloud-credentials.env 找到。"
}

# 执行安装
run_install() {
    log_step "启动正式安装程序..."
    bash install.sh
}

# 主程序
main() {
    echo -e "${GREEN}"
    echo "============================================================"
    echo "       SupaCloud - 下一代企业级 Supabase 私有化部署"
    echo "============================================================"
    echo -e "${NC}"

    install_base_deps
    clone_repo
    generate_config
    run_install
}

main "$@"

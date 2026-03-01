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

# ⚠️ OpenCloudOS 兼容性预检查
# 注意：不再锁定 OpenSSL，因为会阻止必要的包安装
# 改为在 install.sh 中处理 repo 兼容性问题
check_openssl_compat() {
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        case "$ID" in
            opencloudos|tencentos)
                log_warn "检测到 $PRETTY_NAME"
                log_warn "将使用兼容模式安装，避免 Pigsty 使用 Rocky Linux 源"
                export USE_OPENCLOUDOS_COMPAT=true
                ;;
        esac
    fi
}

# 生成配置
# 生成配置
generate_config() {
    log_step "准备安装配置..."
    
    CONFIG_FILE="config.env"
    if [[ -f "$CONFIG_FILE" ]]; then
        log_info "配置文件已存在，将使用现有配置"
        return
    fi

    # 自动获取内网 IP
    if [[ -z "$INTERNAL_IP" ]]; then
        INTERNAL_IP=$(hostname -I | awk '{print $1}')
    fi
    
    # 域名逻辑：环境变量 > 交互输入 > 自动生成 (nip.io)
    if [[ -z "$SUPABASE_PUBLIC_DOMAIN" ]]; then
        if [ -t 0 ]; then
            echo -e "${YELLOW}请输入您的 Supabase API 域名 (直接回车将使用 api.${INTERNAL_IP}.nip.io)${NC}"
            read -p "域名: " SUPABASE_PUBLIC_DOMAIN
        fi
        
        if [[ -z "$SUPABASE_PUBLIC_DOMAIN" ]]; then
            SUPABASE_PUBLIC_DOMAIN="api.${INTERNAL_IP}.nip.io"
            log_info "使用自动分配域名: $SUPABASE_PUBLIC_DOMAIN"
        fi
    fi

    # 自动生成强密码 (如果环境变量没给)
    [[ -z "$POSTGRES_PASSWORD" ]] && POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)
    [[ -z "$DASHBOARD_PASSWORD" ]] && DASHBOARD_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)
    [[ -z "$GRAFANA_PASSWORD" ]] && GRAFANA_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)

    # 写入配置
    cat > "$CONFIG_FILE" << EOF
#!/bin/bash
# SupaCloud 自动生成的配置文件

INTERNAL_IP="${INTERNAL_IP}"
SUPABASE_PUBLIC_DOMAIN="${SUPABASE_PUBLIC_DOMAIN}"
SUPABASE_STUDIO_DOMAIN="${SUPABASE_STUDIO_DOMAIN:-studio.${SUPABASE_PUBLIC_DOMAIN}}"

DASHBOARD_USERNAME="${DASHBOARD_USERNAME:-admin}"
DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD}"
GRAFANA_PASSWORD="${GRAFANA_PASSWORD}"

SWAP_SIZE_GB="${SWAP_SIZE_GB:-4}"
PG_VERSION="${PG_VERSION:-18}"
S3_STORAGE_TYPE="${S3_STORAGE_TYPE:-juicefs}"
EDGE_RUNTIME="${EDGE_RUNTIME:-deno}"
ENABLE_ANALYTICS="${ENABLE_ANALYTICS:-true}"
ANALYTICS_BACKEND="${ANALYTICS_BACKEND:-postgres}"
EOF

    log_info "配置已就绪: $CONFIG_FILE"
    echo -e "----------------------------------------"
    echo -e "API 域名:      ${SUPABASE_PUBLIC_DOMAIN}"
    echo -e "Studio 密码:   ${DASHBOARD_PASSWORD}"
    echo -e "数据库密码:    ${POSTGRES_PASSWORD}"
    echo -e "----------------------------------------"
    log_warn "请记录以上密码。安装即刻开始..."
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
    check_openssl_compat
    generate_config
    run_install
}

main "$@"

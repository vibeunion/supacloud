#!/bin/bash
# ============================================================
# Pigsty Supabase 一键安装脚本
# 
# 使用方法:
#   1. 编辑 config.env 配置文件
#   2. 运行: sudo bash install.sh
#
# 支持系统: Rocky Linux 8/9, AlmaLinux 8/9, Ubuntu 22.04/24.04, Debian 12
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.env"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

# ========== 检查配置文件 ==========
check_config() {
    log_step "检查配置文件..."
    
    if [[ ! -f "$CONFIG_FILE" ]]; then
        log_error "配置文件不存在: $CONFIG_FILE"
        log_info "请先复制并编辑配置文件: cp config.env.example config.env"
        exit 1
    fi
    
    source "$CONFIG_FILE"
    
    # 1. 验证/获取 INTERNAL_IP
    if [[ -z "$INTERNAL_IP" || "$INTERNAL_IP" == "10.6.0.9" ]]; then
        log_info "检查内网 IP..."
        # 获取所有非回环 IP
        IPS=($(hostname -I 2>/dev/null))
        
        if [[ ${#IPS[@]} -eq 0 ]]; then
            log_warn "无法自动检测到 IP 地址"
            while [[ -z "$INTERNAL_IP" || "$INTERNAL_IP" == "10.6.0.9" ]]; do
                read -p "请输入服务器内网 IP: " INTERNAL_IP
            done
        elif [[ ${#IPS[@]} -eq 1 ]]; then
            INTERNAL_IP="${IPS[0]}"
            log_info "自动检测到内网 IP: $INTERNAL_IP"
        else
            log_warn "检测到多个 IP 地址，请选择:"
            for i in "${!IPS[@]}"; do
                echo "  [$((i+1))] ${IPS[$i]}"
            done
            
            while true; do
                read -p "请输入序号 (1-${#IPS[@]}) 或直接输入 IP: " selection
                if [[ "$selection" =~ ^[0-9]+$ ]] && (( selection >= 1 && selection <= ${#IPS[@]} )); then
                    INTERNAL_IP="${IPS[$((selection-1))]}"
                    break
                elif [[ -n "$selection" ]]; then
                    INTERNAL_IP="$selection"
                    break
                fi
            done
        fi
        log_info "已设置内网 IP: $INTERNAL_IP"
    else
        log_info "使用配置的内网 IP: $INTERNAL_IP"
    fi
    
    # 2. 验证/获取 域名配置
    # 兼容旧配置
    if [[ -n "$SUPABASE_DOMAIN" && -z "$SUPABASE_PUBLIC_DOMAIN" ]]; then
        SUPABASE_PUBLIC_DOMAIN="$SUPABASE_DOMAIN"
    fi

    # 获取 Public Domain
    if [[ -z "$SUPABASE_PUBLIC_DOMAIN" || "$SUPABASE_PUBLIC_DOMAIN" == "supa.example.com" ]]; then
        log_warn "未配置 API/对外域名 (SUPABASE_PUBLIC_DOMAIN)"
        while [[ -z "$SUPABASE_PUBLIC_DOMAIN" || "$SUPABASE_PUBLIC_DOMAIN" == "supa.example.com" ]]; do
            read -p "请输入 Supabase API 域名 (例如 supa.example.com): " SUPABASE_PUBLIC_DOMAIN
        done
    fi
    log_info "API 域名: $SUPABASE_PUBLIC_DOMAIN"

    # 获取 Studio Domain
    if [[ -z "$SUPABASE_STUDIO_DOMAIN" ]]; then
        # 默认建议 studio.xxx 或使用 api 域名
        DEFAULT_STUDIO_DOMAIN="studio.${SUPABASE_PUBLIC_DOMAIN#supa.}" # 简单的 supa.xxx -> studio.xxx 猜测
        if [[ "$SUPABASE_PUBLIC_DOMAIN" != *"supa"* ]]; then
            DEFAULT_STUDIO_DOMAIN="studio.${SUPABASE_PUBLIC_DOMAIN}"
        fi
        
        log_info "配置 Studio 域名 (可选)"
        read -p "请输入 Studio 域名 [默认为 $DEFAULT_STUDIO_DOMAIN]: " INPUT_STUDIO_DOMAIN
        
        if [[ -n "$INPUT_STUDIO_DOMAIN" ]]; then
            SUPABASE_STUDIO_DOMAIN="$INPUT_STUDIO_DOMAIN"
        else
            SUPABASE_STUDIO_DOMAIN="$DEFAULT_STUDIO_DOMAIN"
        fi
    fi
    log_info "Studio 域名: $SUPABASE_STUDIO_DOMAIN"
    
    # 自动生成 JWT 密钥
    generate_jwt_keys
    
    log_info "配置验证通过"
    log_info "  内网 IP: $INTERNAL_IP"
    log_info "  API 域名: $SUPABASE_PUBLIC_DOMAIN"
    log_info "  Studio 域名: $SUPABASE_STUDIO_DOMAIN"
}

# ========== 生成 JWT 密钥 ==========
generate_jwt_keys() {
    log_step "检查 JWT 配置..."
    
    # 如果 JWT_SECRET 未设置或为空，自动生成
    if [[ -z "$JWT_SECRET" ]]; then
        log_info "自动生成 JWT_SECRET..."
        JWT_SECRET=$(openssl rand -base64 32 | tr -d '\n')
    else
        log_info "使用自定义 JWT_SECRET"
    fi
    
    # 如果 ANON_KEY 未设置或为空，自动生成
    if [[ -z "$ANON_KEY" ]]; then
        log_info "自动生成 ANON_KEY..."
        # 生成 anon 角色的 JWT
        ANON_PAYLOAD=$(echo -n '{"role":"anon","iss":"supabase","iat":'"$(date +%s)"',"exp":'"$(($(date +%s) + 157680000))"'}' | base64 -w 0 | tr '+/' '-_' | tr -d '=')
        ANON_HEADER=$(echo -n '{"alg":"HS256","typ":"JWT"}' | base64 -w 0 | tr '+/' '-_' | tr -d '=')
        ANON_SIGNATURE=$(echo -n "${ANON_HEADER}.${ANON_PAYLOAD}" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | base64 -w 0 | tr '+/' '-_' | tr -d '=')
        ANON_KEY="${ANON_HEADER}.${ANON_PAYLOAD}.${ANON_SIGNATURE}"
    else
        log_info "使用自定义 ANON_KEY"
    fi
    
    # 如果 SERVICE_ROLE_KEY 未设置或为空，自动生成
    if [[ -z "$SERVICE_ROLE_KEY" ]]; then
        log_info "自动生成 SERVICE_ROLE_KEY..."
        # 生成 service_role 角色的 JWT
        SERVICE_PAYLOAD=$(echo -n '{"role":"service_role","iss":"supabase","iat":'"$(date +%s)"',"exp":'"$(($(date +%s) + 157680000))"'}' | base64 -w 0 | tr '+/' '-_' | tr -d '=')
        SERVICE_HEADER=$(echo -n '{"alg":"HS256","typ":"JWT"}' | base64 -w 0 | tr '+/' '-_' | tr -d '=')
        SERVICE_SIGNATURE=$(echo -n "${SERVICE_HEADER}.${SERVICE_PAYLOAD}" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | base64 -w 0 | tr '+/' '-_' | tr -d '=')
        SERVICE_ROLE_KEY="${SERVICE_HEADER}.${SERVICE_PAYLOAD}.${SERVICE_SIGNATURE}"
    else
        log_info "使用自定义 SERVICE_ROLE_KEY"
    fi
    
    # 保存生成的密钥到文件
    mkdir -p /etc/supabase
    cat > /etc/supabase/jwt-keys.env << EOF
# Supabase JWT Keys - 自动生成于 $(date)
# 请妥善保管此文件！

JWT_SECRET="${JWT_SECRET}"
ANON_KEY="${ANON_KEY}"
SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}"
EOF
    chmod 600 /etc/supabase/jwt-keys.env
    
    log_info "JWT 密钥已保存到: /etc/supabase/jwt-keys.env"
}

# ========== 检查系统要求 ==========
check_system() {
    log_step "检查系统要求..."
    
    # 检查 root 权限
    if [[ $EUID -ne 0 ]]; then
        log_error "请使用 root 用户运行此脚本"
        exit 1
    fi
    
    # 检查操作系统
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        log_info "操作系统: $PRETTY_NAME"
    else
        log_error "无法识别操作系统"
        exit 1
    fi
    
    # 检查架构
    ARCH=$(uname -m)
    if [[ "$ARCH" != "x86_64" && "$ARCH" != "aarch64" ]]; then
        log_error "不支持的架构: $ARCH"
        exit 1
    fi
    log_info "系统架构: $ARCH"
}

# ========== 检查并配置 Swap ==========
setup_swap() {
    log_step "检查内存和 Swap..."
    
    # 首先检查系统是否已有 Swap
    CURRENT_SWAP=$(swapon --show --noheadings | wc -l)
    
    if [[ "$CURRENT_SWAP" -gt 0 ]]; then
        log_info "系统已有 Swap，跳过创建"
        swapon --show
        return
    fi
    
    TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    TOTAL_MEM_GB=$(echo "scale=2; $TOTAL_MEM_KB / 1024 / 1024" | bc)
    
    log_info "总内存: ${TOTAL_MEM_GB}GB"
    
    # 检查是否需要 Swap (< 3.5GB)
    NEED_SWAP=$(echo "$TOTAL_MEM_GB < 3.5" | bc)
    
    if [[ "$NEED_SWAP" -eq 1 ]]; then
        SWAP_SIZE=${SWAP_SIZE_GB:-4}
        log_warn "内存低于 3.5GB，将创建 ${SWAP_SIZE}GB Swap"
        
        if [[ -f /swapfile ]]; then
            log_info "Swap 文件已存在，正在启用..."
            swapon /swapfile 2>/dev/null || true
        else
            fallocate -l ${SWAP_SIZE}G /swapfile
            chmod 600 /swapfile
            mkswap /swapfile
            swapon /swapfile
            
            # 添加到 fstab
            if ! grep -q "/swapfile" /etc/fstab; then
                echo '/swapfile none swap sw 0 0' >> /etc/fstab
            fi
            
            log_info "Swap 创建完成"
        fi
        
        # 显示当前 Swap 状态
        swapon --show
    else
        log_info "内存充足 (${TOTAL_MEM_GB}GB)，无需创建 Swap"
    fi
}

# ========== 安装容器运行时 ==========
install_container_runtime() {
    log_step "检查容器运行时..."
    
    # 检查 Docker 或 Podman
    if command -v docker &> /dev/null; then
        log_info "Docker 已安装: $(docker --version)"
        CONTAINER_RUNTIME="docker"
    elif command -v podman &> /dev/null; then
        log_info "Podman 已安装: $(podman --version)"
        CONTAINER_RUNTIME="podman"
    else
        log_warn "未检测到容器运行时，将安装 Podman"
        install_podman
        CONTAINER_RUNTIME="podman"
        log_info "Podman 安装完成"
    fi
    
    # 确保 Docker socket 可用 (for podman)
    if [[ "$CONTAINER_RUNTIME" == "podman" ]]; then
        setup_podman_socket
    fi
}

# ========== 安装 Podman (多发行版支持) ==========
install_podman() {
    # 检测发行版
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        DISTRO_ID="${ID,,}"  # 转小写
        DISTRO_VERSION_ID="${VERSION_ID%%.*}"  # 主版本号
    else
        log_error "无法识别操作系统"
        exit 1
    fi
    
    log_info "检测到系统: $DISTRO_ID $VERSION_ID"
    
    case "$DISTRO_ID" in
        # RHEL 系列 (Rocky, Alma, CentOS, RHEL, OpenCloudOS)
        rocky|almalinux|centos|rhel|opencloudos|tencentos|anolis)
            log_info "使用 dnf/yum 安装 Podman..."
            if command -v dnf &> /dev/null; then
                dnf install -y podman podman-docker
            else
                yum install -y podman podman-docker
            fi
            ;;
        
        # Fedora
        fedora)
            log_info "使用 dnf 安装 Podman..."
            dnf install -y podman podman-docker
            ;;
        
        # Debian
        debian)
            log_info "使用 apt 安装 Podman..."
            apt-get update
            if [[ "$DISTRO_VERSION_ID" -ge 11 ]]; then
                apt-get install -y podman
            else
                log_error "Debian 版本过低，需要 Debian 11+"
                exit 1
            fi
            ;;
        
        # Ubuntu
        ubuntu)
            log_info "使用 apt 安装 Podman..."
            apt-get update
            if [[ "$DISTRO_VERSION_ID" -ge 22 ]]; then
                apt-get install -y podman
            elif [[ "$DISTRO_VERSION_ID" -ge 20 ]]; then
                # Ubuntu 20.04 需要添加 kubic 仓库
                source /etc/os-release
                echo "deb https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/stable/xUbuntu_${VERSION_ID}/ /" | tee /etc/apt/sources.list.d/devel:kubic:libcontainers:stable.list
                curl -L "https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/stable/xUbuntu_${VERSION_ID}/Release.key" | apt-key add -
                apt-get update
                apt-get install -y podman
            else
                log_error "Ubuntu 版本过低，需要 Ubuntu 20.04+"
                exit 1
            fi
            ;;
        
        # openSUSE
        opensuse*|sles)
            log_info "使用 zypper 安装 Podman..."
            zypper install -y podman
            ;;
        
        # Arch Linux
        arch|manjaro)
            log_info "使用 pacman 安装 Podman..."
            pacman -Sy --noconfirm podman
            ;;
        
        *)
            log_error "不支持的发行版: $DISTRO_ID"
            log_info "请手动安装 Podman 后重新运行此脚本"
            exit 1
            ;;
    esac
    
    # 创建 podman-docker 符号链接 (如果没有 podman-docker 包)
    if ! command -v docker &> /dev/null && command -v podman &> /dev/null; then
        ln -sf /usr/bin/podman /usr/local/bin/docker 2>/dev/null || true
    fi
}

# ========== 配置 Podman 镜像加速 ==========
configure_podman_mirrors() {
    log_info "配置 Podman 镜像加速..."
    
    mkdir -p /etc/containers
    
    cat > /etc/containers/registries.conf << EOF
unqualified-search-registries = ["docker.io"]

[[registry]]
prefix = "docker.io"
location = "mirror.ccs.tencentyun.com"
insecure = true

[[registry.mirror]]
location = "docker.m.ixdev.cn"
insecure = true

[[registry.mirror]]
location = "docker.1panel.live"
insecure = true

[[registry.mirror]]
location = "hub-mirror.c.163.com"
insecure = true
EOF

    log_info "Podman 镜像加速配置完成"
}

# ========== 配置 Podman Socket ==========
setup_podman_socket() {
    log_info "配置 Podman socket..."
    
    # 启用 podman socket
    if systemctl list-unit-files | grep -q podman.socket; then
        systemctl enable --now podman.socket || true
    fi
    
    # 创建 Docker socket 符号链接
    if [[ -S /run/podman/podman.sock ]] && [[ ! -e /var/run/docker.sock ]]; then
        ln -sf /run/podman/podman.sock /var/run/docker.sock
    fi
     
    # 配置镜像加速
    configure_podman_mirrors
}

# ========== 安装 Docker Compose ==========
install_docker_compose() {
    log_step "检查 Docker Compose..."
    
    # 检查是否已安装
    if command -v docker-compose &> /dev/null; then
        log_info "Docker Compose 已安装: $(docker-compose --version)"
        return
    fi
    
    # 检查 docker compose (plugin 形式)
    if docker compose version &> /dev/null 2>&1; then
        log_info "Docker Compose (plugin) 已安装"
        return
    fi
    
    log_warn "Docker Compose 未安装，正在安装..."
    
    COMPOSE_VERSION="v2.32.3"
    COMPOSE_URL="https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)"
    
    # 尝试使用代理
    if curl -s --connect-timeout 5 https://github.com &> /dev/null; then
        curl -L "$COMPOSE_URL" -o /usr/local/bin/docker-compose
    else
        log_info "使用代理下载..."
        curl -L "https://gh-proxy.net/$COMPOSE_URL" -o /usr/local/bin/docker-compose
    fi
    
    chmod +x /usr/local/bin/docker-compose
    log_info "Docker Compose 安装完成: $(/usr/local/bin/docker-compose --version)"
}

# ========== Edge Functions 运行时配置 ==========
configure_edge_runtime() {
    log_step "配置 Edge Functions 运行时 (${EDGE_RUNTIME:-deno})..."
    
    case "${EDGE_RUNTIME:-deno}" in
        deno)
            log_info "使用 Supabase 官方 Deno 运行时"
            ;;
        bun)
            install_bun_runtime
            ;;
        *)
            log_warn "未知的运行时: $EDGE_RUNTIME，使用默认 Deno"
            ;;
    esac
}

# ========== 安装 Bun 运行时 (Docker Hub 镜像) ==========
install_bun_runtime() {
    log_step "安装 Bun.js 运行时（Docker Hub 镜像）..."
    
    # Docker Hub 镜像地址
    BUN_FUNCTIONS_IMAGE="${BUN_FUNCTIONS_IMAGE:-zuohuadong/supabase-bun-function:latest}"
    BUN_FUNCTIONS_DIR="${BUN_FUNCTIONS_DIR:-bun-functions}"
    BUN_FUNCTIONS_PORT="${BUN_FUNCTIONS_PORT:-9001}"
    
    log_info "使用镜像: ${BUN_FUNCTIONS_IMAGE}"
    
    # 创建函数目录
    mkdir -p /opt/supabase/${BUN_FUNCTIONS_DIR}/functions
    mkdir -p /etc/supabase
    
    # 创建示例函数
    mkdir -p /opt/supabase/${BUN_FUNCTIONS_DIR}/functions/hello
    cat > /opt/supabase/${BUN_FUNCTIONS_DIR}/functions/hello/index.ts << 'EOF'
// Example Bun Edge Function
// Compatible with supabase.functions.invoke('hello', { body: { name: 'World' } })

interface FunctionContext {
  req: Request;
  headers: Record<string, string>;
  body: any;
  params: Record<string, string>;
  query: Record<string, string>;
  env: {
    SUPABASE_URL?: string;
    SUPABASE_ANON_KEY?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
  };
}

export default async function handler(ctx: FunctionContext) {
  const name = ctx.body?.name || ctx.query?.name || 'World';
  
  return {
    message: `Hello, ${name}!`,
    runtime: 'bun',
    timestamp: new Date().toISOString(),
  };
}
EOF
    
    # 加载 JWT 密钥
    if [[ -f /etc/supabase/jwt-keys.env ]]; then
        set -a
        source /etc/supabase/jwt-keys.env
        set +a
    fi
    
    # 拉取并启动容器
    log_info "拉取 Docker Hub 镜像..."
    
    if command -v podman &> /dev/null; then
        # 使用 Podman
        podman pull "${BUN_FUNCTIONS_IMAGE}"
        
        # 停止旧容器
        podman stop supabase-bun-functions 2>/dev/null || true
        podman rm supabase-bun-functions 2>/dev/null || true
        
        # 启动新容器
        podman run -d --name supabase-bun-functions \
            --restart unless-stopped \
            -p ${BUN_FUNCTIONS_PORT}:9001 \
            -e PORT=9001 \
            -e JWT_SECRET="${JWT_SECRET}" \
            -e ANON_KEY="${ANON_KEY}" \
            -e SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}" \
            -e SUPABASE_URL="http://localhost:8000" \
            -v /opt/supabase/${BUN_FUNCTIONS_DIR}/functions:/app/functions:ro \
            --network supabase_default \
            "${BUN_FUNCTIONS_IMAGE}"
            
    elif command -v docker &> /dev/null; then
        # 使用 Docker
        docker pull "${BUN_FUNCTIONS_IMAGE}"
        
        # 停止旧容器
        docker stop supabase-bun-functions 2>/dev/null || true
        docker rm supabase-bun-functions 2>/dev/null || true
        
        # 启动新容器
        docker run -d --name supabase-bun-functions \
            --restart unless-stopped \
            -p ${BUN_FUNCTIONS_PORT}:9001 \
            -e PORT=9001 \
            -e JWT_SECRET="${JWT_SECRET}" \
            -e ANON_KEY="${ANON_KEY}" \
            -e SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}" \
            -e SUPABASE_URL="http://localhost:8000" \
            -v /opt/supabase/${BUN_FUNCTIONS_DIR}/functions:/app/functions:ro \
            --network supabase_default \
            "${BUN_FUNCTIONS_IMAGE}"
    else
        log_error "未找到 Docker 或 Podman"
        return 1
    fi
    
    # 保存配置
    cat > /etc/supabase/bun-functions.env << EOF
# Bun Edge Functions 配置 (Docker Hub 镜像)
BUN_FUNCTIONS_IMAGE=${BUN_FUNCTIONS_IMAGE}
BUN_FUNCTIONS_PORT=${BUN_FUNCTIONS_PORT}
BUN_FUNCTIONS_DIR=/opt/supabase/${BUN_FUNCTIONS_DIR}
BUN_FUNCTIONS_CONTAINER=supabase-bun-functions
EOF
    
    # 标记使用 Bun 运行时
    touch /etc/supabase/.use_bun_runtime
    
    log_info "Bun Edge Functions 安装完成"
    log_info "  镜像: ${BUN_FUNCTIONS_IMAGE}"
    log_info "  容器: supabase-bun-functions"
    log_info "  端口: ${BUN_FUNCTIONS_PORT}"
    log_info "  函数目录: /opt/supabase/${BUN_FUNCTIONS_DIR}/functions"
    log_info "  API: http://localhost:${BUN_FUNCTIONS_PORT}/{function}"
}

# ========== S3 存储安装 ==========
install_s3_storage() {
    log_step "配置 S3 存储 (${S3_STORAGE_TYPE:-minio})..."
    
    case "${S3_STORAGE_TYPE:-minio}" in
        minio)
            log_info "使用 Pigsty 内置 MinIO，无需额外安装"
            ;;
        garage)
            install_garage
            ;;
        rustfs)
            install_rustfs
            ;;
        external)
            log_info "使用外部 S3 存储，跳过本地安装"
            configure_external_s3
            ;;
        *)
            log_error "未知的 S3 存储类型: $S3_STORAGE_TYPE"
            exit 1
            ;;
    esac
}

# ========== 安装 Garage ==========
install_garage() {
    log_step "安装 Garage S3..."
    
    GARAGE_VERSION="v1.0.1"
    GARAGE_ARCH=$(uname -m)
    
    # 架构映射
    case "$GARAGE_ARCH" in
        x86_64) GARAGE_ARCH="x86_64" ;;
        aarch64) GARAGE_ARCH="aarch64" ;;
        *) log_error "不支持的架构: $GARAGE_ARCH"; exit 1 ;;
    esac
    
    # 优先使用配置中的自定义下载地址
    if [[ -n "$GARAGE_DOWNLOAD_URL" ]]; then
        GARAGE_URL="$GARAGE_DOWNLOAD_URL"
    else
        GARAGE_URL="https://garagehq.deuxfleurs.fr/_releases/${GARAGE_VERSION}/${GARAGE_ARCH}-unknown-linux-musl/garage"
    fi
    
    # 下载 Garage
    if [[ ! -f /usr/local/bin/garage ]]; then
        log_info "下载 Garage ${GARAGE_VERSION}..."
        log_info "下载地址: $GARAGE_URL"
        
        if curl -L --progress-bar "$GARAGE_URL" -o /usr/local/bin/garage; then
            chmod +x /usr/local/bin/garage
            log_info "Garage 下载成功"
        else
            log_error "Garage 下载失败"
            rm -f /usr/local/bin/garage
            exit 1
        fi
    fi
    
    # 创建配置目录
    mkdir -p /etc/garage /var/lib/garage
    
    # 生成配置文件
    GARAGE_SECRET=$(openssl rand -hex 32)
    GARAGE_RPC_SECRET=$(openssl rand -hex 32)
    
    cat > /etc/garage/garage.toml << EOF
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "lmdb"

replication_factor = 1

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "${INTERNAL_IP}:3901"
rpc_secret = "${GARAGE_RPC_SECRET}"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[s3_web]
bind_addr = "[::]:3902"
root_domain = ".web.garage.localhost"

[admin]
api_bind_addr = "[::]:3903"
admin_token = "${GARAGE_SECRET}"
EOF
    
    # 创建 systemd 服务
    cat > /etc/systemd/system/garage.service << EOF
[Unit]
Description=Garage S3-compatible object storage
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/garage -c /etc/garage/garage.toml server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    
    # 启动服务
    systemctl daemon-reload
    systemctl enable --now garage
    
    # 等待启动
    # 等待启动
    log_info "等待 Garage 启动 (5s)..."
    sleep 5
    
    # 初始化集群
    log_info "初始化 Garage 集群..."
    GARAGE_NODE_ID=$(garage -c /etc/garage/garage.toml node id -q 2>/dev/null | head -1)
    if [[ -n "$GARAGE_NODE_ID" ]]; then
        garage -c /etc/garage/garage.toml layout assign -z dc1 -c 1G "$GARAGE_NODE_ID" || true
        garage -c /etc/garage/garage.toml layout apply --version 1 || true
    fi
    
    # 创建访问密钥
    log_info "创建 Garage 访问密钥..."
    GARAGE_KEY_OUTPUT=$(garage -c /etc/garage/garage.toml key create supabase-key 2>/dev/null || true)
    
    # 创建 bucket
    garage -c /etc/garage/garage.toml bucket create supabase-storage || true
    garage -c /etc/garage/garage.toml bucket create pgsql || true
    garage -c /etc/garage/garage.toml bucket allow --read --write supabase-storage --key supabase-key || true
    garage -c /etc/garage/garage.toml bucket allow --read --write pgsql --key supabase-key || true
    
    # 保存密钥信息
    echo "# Garage S3 配置" > /etc/garage/s3-credentials.env
    echo "S3_ENDPOINT=http://${INTERNAL_IP}:3900" >> /etc/garage/s3-credentials.env
    garage -c /etc/garage/garage.toml key info supabase-key 2>/dev/null | grep -E "Key ID|Secret key" >> /etc/garage/s3-credentials.env || true
    
    # 设置环境变量供后续使用
    S3_ENDPOINT="http://${INTERNAL_IP}:3900"
    S3_REGION="garage"
    
    log_info "Garage 安装完成"
    log_info "  端点: http://${INTERNAL_IP}:3900"
    log_info "  密钥信息: /etc/garage/s3-credentials.env"
}

# ========== 安装 RustFS ==========
install_rustfs() {
    log_step "安装 RustFS..."
    
    RUSTFS_VERSION="v0.8.1"
    RUSTFS_ARCH=$(uname -m)
    
    # 架构映射
    case "$RUSTFS_ARCH" in
        x86_64) RUSTFS_ARCH="x86_64-unknown-linux-musl" ;;
        aarch64) RUSTFS_ARCH="aarch64-unknown-linux-musl" ;;
        *) log_error "不支持的架构: $RUSTFS_ARCH"; exit 1 ;;
    esac
    
    RUSTFS_URL="https://github.com/RustFS/rustfs/releases/download/${RUSTFS_VERSION}/rustfs-${RUSTFS_ARCH}.tar.gz"
    
    # 下载 RustFS
    if [[ ! -f /usr/local/bin/rustfs ]]; then
        log_info "下载 RustFS ${RUSTFS_VERSION}..."
        cd /tmp
        curl -L "$RUSTFS_URL" -o rustfs.tar.gz
        tar -xzf rustfs.tar.gz
        mv rustfs /usr/local/bin/
        chmod +x /usr/local/bin/rustfs
        rm -f rustfs.tar.gz
    fi
    
    # 创建数据目录
    mkdir -p /var/lib/rustfs
    
    # 生成访问密钥
    RUSTFS_ACCESS_KEY=$(openssl rand -hex 10)
    RUSTFS_SECRET_KEY=$(openssl rand -hex 20)
    
    # 创建 systemd 服务
    cat > /etc/systemd/system/rustfs.service << EOF
[Unit]
Description=RustFS S3-compatible object storage
After=network.target

[Service]
Type=simple
Environment="RUSTFS_ROOT_USER=${RUSTFS_ACCESS_KEY}"
Environment="RUSTFS_ROOT_PASSWORD=${RUSTFS_SECRET_KEY}"
ExecStart=/usr/local/bin/rustfs server /var/lib/rustfs --address :9000 --console-address :9001
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    
    # 保存凭据
    cat > /etc/rustfs-credentials.env << EOF
# RustFS S3 配置
S3_ENDPOINT=http://${INTERNAL_IP}:9000
S3_ACCESS_KEY=${RUSTFS_ACCESS_KEY}
S3_SECRET_KEY=${RUSTFS_SECRET_KEY}
S3_REGION=us-east-1
EOF
    
    chmod 600 /etc/rustfs-credentials.env
    
    # 启动服务
    systemctl daemon-reload
    systemctl enable --now rustfs
    
    # 等待启动
    sleep 3
    
    # 设置环境变量供后续使用
    S3_ENDPOINT="http://${INTERNAL_IP}:9000"
    S3_ACCESS_KEY="$RUSTFS_ACCESS_KEY"
    S3_SECRET_KEY="$RUSTFS_SECRET_KEY"
    S3_REGION="us-east-1"
    
    log_info "RustFS 安装完成"
    log_info "  S3 端点: http://${INTERNAL_IP}:9000"
    log_info "  控制台: http://${INTERNAL_IP}:9001"
    log_info "  凭据文件: /etc/rustfs-credentials.env"
}

# ========== 配置外部 S3 ==========
configure_external_s3() {
    log_info "配置外部 S3 存储..."
    
    if [[ -z "$EXTERNAL_S3_ENDPOINT" ]]; then
        log_error "使用外部 S3 时必须配置 EXTERNAL_S3_ENDPOINT"
        exit 1
    fi
    
    S3_ENDPOINT="$EXTERNAL_S3_ENDPOINT"
    S3_ACCESS_KEY="${EXTERNAL_S3_ACCESS_KEY:-}"
    S3_SECRET_KEY="${EXTERNAL_S3_SECRET_KEY:-}"
    S3_REGION="${EXTERNAL_S3_REGION:-us-east-1}"
    S3_BUCKET="${EXTERNAL_S3_BUCKET:-supabase-storage}"
    
    log_info "  端点: $S3_ENDPOINT"
    log_info "  区域: $S3_REGION"
}

# ========== 安装 Pigsty ==========
# ========== 操作系统全兼容 OpenResty 劫持逻辑 ==========
install_enhanced_gateway() {
    log_step "正在安装 OpenResty (全兼容模式)..."

    # 识别操作系统
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        DISTRO_ID="${ID,,}"
    fi

    log_info "检测到系统类型: $DISTRO_ID"

    case "$DISTRO_ID" in
        # RHEL 系列 (Rocky, Alma, OpenCloudOS, CentOS, RHEL, Anolis)
        rocky|almalinux|opencloudos|centos|rhel|anolis|tencentos)
            log_info "配置 RHEL 系 OpenResty 仓库..."
            if command -v dnf &> /dev/null; then
                dnf install -y yum-utils
                dnf config-manager --add-repo https://openresty.org/package/centos/openresty.repo
                dnf install -y openresty openresty-resty socat luarocks openssl-devel gcc
            else
                yum install -y yum-utils
                yum-config-manager --add-repo https://openresty.org/package/centos/openresty.repo
                yum install -y openresty openresty-resty socat luarocks openssl-devel gcc
            fi
            ;;
        
        # Debian/Ubuntu 系列
        debian|ubuntu)
            log_info "配置 Debian 系 OpenResty 仓库..."
            apt-get update
            apt-get install -y wget gnupg2 software-properties-common
            wget -qO - https://openresty.org/package/pubkey.gpg | apt-key add -
            add-apt-repository -y "deb http://openresty.org/package/$(lsb_release -sc) $(lsb_release -sc) main"
            apt-get update
            apt-get install -y openresty socat luarocks libssl-dev gcc
            ;;
        
        *)
            log_error "不支持的操作系统: $DISTRO_ID"
            exit 1
            ;;
    esac

    # 1. 安装自动 SSL 核心模块
    log_info "安装 lua-resty-auto-ssl..."
    luarocks install lua-resty-auto-ssl

    # 2. 建立证书存储目录
    mkdir -p /etc/resty-auto-ssl
    # 根据运行用户赋权 (OpenResty 默认可能是 nobody)
    chown -R nobody:nobody /etc/resty-auto-ssl 2>/dev/null || true

    # 3. 核心劫持：将 OpenResty 伪装成 Nginx
    log_info "执行网关劫持..."
    systemctl stop nginx 2>/dev/null || true
    systemctl disable nginx 2>/dev/null || true

    # 软链接 OpenResty 二进制到 Nginx 标准路径
    # 这让 Pigsty 的 Ansible 脚本运行 `nginx` 命令时调用的实际上是 openresty
    if [[ -f /usr/local/openresty/bin/openresty ]]; then
        ln -sf /usr/local/openresty/bin/openresty /usr/sbin/nginx
    fi
    
    # 模拟 Nginx 的配置布局
    mkdir -p /etc/nginx/conf.d
    # 让 OpenResty 能够通过标准路径引用 LuaRocks 安装的库
    ln -sf /usr/local/share/lua/5.1/resty /usr/local/openresty/lualib/resty 2>/dev/null || true

    log_info "网关环境准备完成"
}

# ========== 注入 Lua 自动 SSL 逻辑到 Pigsty 模板 ==========
inject_lua_config() {
    log_step "正在向 Pigsty 模板注入 Lua 逻辑..."
    
    # 定义 Pigsty 模板路径
    NGINX_CONF_J2=~/pigsty/roles/nginx/templates/nginx.conf.j2
    
    if [[ ! -f "$NGINX_CONF_J2" ]]; then
        log_warn "未找到模板 $NGINX_CONF_J2，请检查系统安装路径"
        return
    fi

    # 检查是否已经注入过
    if grep -q "SupaCloud Auto SSL Start" "$NGINX_CONF_J2"; then
        log_info "Lua 逻辑已存在，跳过注入"
        return
    fi

    # 在 http 块中注入 init 逻辑
    sed -i '/http {/a \
\
    # --- SupaCloud Auto SSL Start --- \
    init_by_lua_block { \
        auto_ssl = require("resty.auto-ssl").new() \
        auto_ssl:set("allow_domain", function(domain) \
            return true \
        end) \
        auto_ssl:init() \
    } \
    init_worker_by_lua_block { \
        auto_ssl:init_worker() \
    } \
    server { \
        listen 127.0.0.1:8999; \
        location / { \
            content_by_lua_block { \
                auto_ssl:hook_server() \
            } \
        } \
    } \
    # --- SupaCloud Auto SSL End ---' "$NGINX_CONF_J2"

    # 针对 Pigsty 默认站点注入 ACME 验证回调
    DEFAULT_SITE_J2=~/pigsty/roles/nginx/templates/sites/default.conf.j2
    if [[ -f "$DEFAULT_SITE_J2" ]]; then
        sed -i '/location \/ {/i \
        location /.well-known/acme-challenge/ { \
            content_by_lua_block { \
                auto_ssl:challenge_server() \
            } \
        }' "$DEFAULT_SITE_J2"
    fi
}

install_pigsty() {
    log_step "安装 Pigsty..."
    
    cd ~
    
    # 下载 Pigsty
    if [[ ! -d ~/pigsty ]]; then
        log_info "下载 Pigsty..."
        curl -fsSL https://repo.pigsty.cc/get | bash
    else
        log_info "Pigsty 目录已存在"
    fi
    
    cd ~/pigsty
    
    # 运行 bootstrap
    log_info "运行 bootstrap..."
    ./bootstrap
    
    # 使用 Supabase 配置模板
    log_info "配置 Supabase 模板..."
    ./configure -i "$INTERNAL_IP" -c app/supa
    
    # 注入 Lua 逻辑到模板
    inject_lua_config
    
    # 修改配置文件
    update_pigsty_config
    
    # 安装 Pigsty
    log_info "安装 Pigsty (这可能需要 10-20 分钟)..."
    ./install.yml
    
    # 安装 Docker
    log_info "配置 Docker..."
    ./docker.yml || true
    
    # 启动 Supabase
    log_info "启动 Supabase..."
    ./app.yml || {
        log_warn "app.yml 失败，尝试手动启动..."
        manual_start_supabase
    }
}

# ========== 更新 Pigsty 配置 ==========
update_pigsty_config() {
    log_step "更新 Pigsty 配置..."
    
    PIGSTY_YML=~/pigsty/pigsty.yml
    
    # 更新域名配置
    # 更新域名配置
    # SITE_URL -> Studio (Dashboard)
    sed -i "s|SITE_URL: https://supa.pigsty|SITE_URL: https://${SUPABASE_STUDIO_DOMAIN}|g" "$PIGSTY_YML"
    
    # API URL -> Public Domain (API Gateway)
    sed -i "s|API_EXTERNAL_URL: https://supa.pigsty|API_EXTERNAL_URL: https://${SUPABASE_PUBLIC_DOMAIN}|g" "$PIGSTY_YML"
    sed -i "s|SUPABASE_PUBLIC_URL: https://supa.pigsty|SUPABASE_PUBLIC_URL: https://${SUPABASE_PUBLIC_DOMAIN}|g" "$PIGSTY_YML"
    
    # Nginx 域名和证书配置
    # 注意: Pigsty 简单模式下 'domain' 变量通常控制主服务器名。
    # 为了支持两个域名，我们需要确保 certbot 申请两个域名通过逗号分隔
    # 并且 Nginx 配置监听这两个域名。
    # 这里我们修改 domain 为 Public Domain (作为主域名)
    sed -i "s|domain: supa.pigsty|domain: ${SUPABASE_PUBLIC_DOMAIN}|g" "$PIGSTY_YML"
    
    # 修改 certbot 申请列表，同时包含 Public 和 Studio 域名
    if [[ "$SUPABASE_PUBLIC_DOMAIN" != "$SUPABASE_STUDIO_DOMAIN" ]]; then
        sed -i "s|certbot: supa.pigsty|certbot: ${SUPABASE_PUBLIC_DOMAIN},${SUPABASE_STUDIO_DOMAIN}|g" "$PIGSTY_YML"
    else
        sed -i "s|certbot: supa.pigsty|certbot: ${SUPABASE_PUBLIC_DOMAIN}|g" "$PIGSTY_YML"
    fi
    
    # 更新 /etc/hosts 配置 (仅作为占位符替换，实际 DNS 由用户配置)
    sed -i "s|supa.pigsty|${SUPABASE_PUBLIC_DOMAIN}|g" "$PIGSTY_YML"
    
    # 更新密码配置
    if [[ -n "$DASHBOARD_PASSWORD" && "$DASHBOARD_PASSWORD" != "your-strong-password" ]]; then
        sed -i "s|DASHBOARD_PASSWORD: pigsty|DASHBOARD_PASSWORD: ${DASHBOARD_PASSWORD}|g" "$PIGSTY_YML"
    fi
    
    if [[ -n "$POSTGRES_PASSWORD" && "$POSTGRES_PASSWORD" != "DBUser.Supa" ]]; then
        sed -i "s|POSTGRES_PASSWORD: DBUser.Supa|POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}|g" "$PIGSTY_YML"
    fi
    
    if [[ -n "$GRAFANA_PASSWORD" && "$GRAFANA_PASSWORD" != "pigsty" ]]; then
        sed -i "s|grafana_admin_password: pigsty|grafana_admin_password: ${GRAFANA_PASSWORD}|g" "$PIGSTY_YML"
    fi
    
    # 更新 JWT 配置（使用自动生成或自定义的值）
    if [[ -n "$JWT_SECRET" ]]; then
        sed -i "s|JWT_SECRET: your-super-secret-jwt-token-with-at-least-32-characters-long|JWT_SECRET: ${JWT_SECRET}|g" "$PIGSTY_YML"
    fi
    
    if [[ -n "$ANON_KEY" ]]; then
        # 更新 ANON_KEY
        sed -i "s|ANON_KEY: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.*|ANON_KEY: ${ANON_KEY}|g" "$PIGSTY_YML"
    fi
    
    if [[ -n "$SERVICE_ROLE_KEY" ]]; then
        # 更新 SERVICE_ROLE_KEY
        sed -i "s|SERVICE_ROLE_KEY: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.*|SERVICE_ROLE_KEY: ${SERVICE_ROLE_KEY}|g" "$PIGSTY_YML"
    fi
    
    # 配置非 MinIO S3 存储
    if [[ "${S3_STORAGE_TYPE:-minio}" != "minio" ]]; then
        configure_s3_in_pigsty
    fi
    
    log_info "配置更新完成"
}

# ========== 配置 S3 存储到 Pigsty ==========
configure_s3_in_pigsty() {
    log_info "配置 ${S3_STORAGE_TYPE} 作为 S3 存储..."
    
    PIGSTY_YML=~/pigsty/pigsty.yml
    SUPABASE_ENV=~/pigsty/app/supabase/.env
    
    # 根据存储类型获取凭据
    case "$S3_STORAGE_TYPE" in
        garage)
            if [[ -f /etc/garage/s3-credentials.env ]]; then
                source /etc/garage/s3-credentials.env 2>/dev/null || true
                # 从 Garage 获取密钥
                S3_ACCESS_KEY=$(garage -c /etc/garage/garage.toml key info supabase-key 2>/dev/null | grep "Key ID" | awk '{print $3}' || echo "")
                S3_SECRET_KEY=$(garage -c /etc/garage/garage.toml key info supabase-key 2>/dev/null | grep "Secret key" | awk '{print $3}' || echo "")
            fi
            S3_ENDPOINT="http://${INTERNAL_IP}:3900"
            S3_REGION="garage"
            ;;
        rustfs)
            if [[ -f /etc/rustfs-credentials.env ]]; then
                source /etc/rustfs-credentials.env
            fi
            S3_ENDPOINT="http://${INTERNAL_IP}:9000"
            ;;
        external)
            S3_ENDPOINT="$EXTERNAL_S3_ENDPOINT"
            S3_ACCESS_KEY="$EXTERNAL_S3_ACCESS_KEY"
            S3_SECRET_KEY="$EXTERNAL_S3_SECRET_KEY"
            S3_REGION="${EXTERNAL_S3_REGION:-us-east-1}"
            ;;
    esac
    
    # 更新 pigsty.yml 中的 S3 配置
    # 注释掉 MinIO 相关配置
    if [[ "${S3_STORAGE_TYPE}" != "minio" ]]; then
        log_info "禁用 Pigsty 内置 MinIO..."
        
        # 在 pigsty.yml 中注释掉 minio 组 (通过添加标记)
        # 这是一个简化处理，实际可能需要更复杂的 YAML 操作
        sed -i 's/^    minio:/#   minio:/g' "$PIGSTY_YML"
        sed -i 's/^      hosts:/#     hosts:/g' "$PIGSTY_YML"
    fi
    
    # 更新 Supabase .env 文件 (如果存在)
    if [[ -f "$SUPABASE_ENV" ]]; then
        log_info "更新 Supabase S3 配置..."
        
        # 更新 S3 端点
        sed -i "s|S3_ENDPOINT=.*|S3_ENDPOINT=${S3_ENDPOINT}|g" "$SUPABASE_ENV"
        
        # 更新访问密钥
        if [[ -n "$S3_ACCESS_KEY" ]]; then
            sed -i "s|S3_ACCESS_KEY=.*|S3_ACCESS_KEY=${S3_ACCESS_KEY}|g" "$SUPABASE_ENV"
        fi
        
        if [[ -n "$S3_SECRET_KEY" ]]; then
            sed -i "s|S3_SECRET_KEY=.*|S3_SECRET_KEY=${S3_SECRET_KEY}|g" "$SUPABASE_ENV"
        fi
        
        if [[ -n "$S3_REGION" ]]; then
            sed -i "s|S3_REGION=.*|S3_REGION=${S3_REGION}|g" "$SUPABASE_ENV"
        fi
    fi
    
    log_info "S3 存储配置完成"
    log_info "  类型: ${S3_STORAGE_TYPE}"
    log_info "  端点: ${S3_ENDPOINT}"
}

# ========== 手动启动 Supabase ==========
manual_start_supabase() {
    log_step "手动启动 Supabase..."
    
    cd ~/pigsty/app/supabase
    
    # 修复 .env 中的 IP
    sed -i "s|POSTGRES_HOST=10.10.10.10|POSTGRES_HOST=${INTERNAL_IP}|g" .env
    
    # 启动服务
    if command -v docker-compose &> /dev/null; then
        docker-compose up -d
    else
        /usr/local/bin/docker-compose up -d
    fi
}

# ========== 部署 MCP Function ==========
deploy_mcp_function() {
    log_step "部署 MCP Edge Function..."
    
    # 1. index.ts
    MCP_INDEX_TS=$(cat << 'EOF'
// Setup type definitions for built-in Supabase Runtime APIs
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

import { McpServer } from 'npm:@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPTransport } from 'npm:@hono/mcp'
import { Hono } from 'npm:hono'
import { z } from 'npm:zod'

// Create Hono app
const app = new Hono()

// Create your MCP server
const server = new McpServer({
  name: 'mcp',
  version: '0.1.0',
})

// Register a simple addition tool
server.registerTool(
  'add',
  {
    title: 'Addition Tool',
    description: 'Add two numbers together',
    inputSchema: { a: z.number(), b: z.number() },
  },
  ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  })
)

// Handle MCP requests at the root path
app.all('/', async (c) => {
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  return transport.handleRequest(c)
})

Deno.serve(app.fetch)
EOF
)

    # 2. deno.json
    MCP_DENO_JSON=$(cat << 'EOF'
{
  "imports": {
    "@hono/mcp": "npm:@hono/mcp@^0.1.1",
    "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@^1.24.3",
    "hono": "npm:hono@^4.9.2",
    "zod": "npm:zod@^4.1.13"
  }
}
EOF
)

    # 部署目标路径
    # 如果是 Deno (Pigsty 默认)
    DENO_FUNC_DIR=~/pigsty/app/supabase/volumes/functions/mcp
    mkdir -p "$DENO_FUNC_DIR"
    echo "$MCP_INDEX_TS" > "$DENO_FUNC_DIR/index.ts"
    echo "$MCP_DENO_JSON" > "$DENO_FUNC_DIR/deno.json"
    log_info "已部署 MCP Function 到 Deno 运行时: $DENO_FUNC_DIR"
    
    # 如果已配置 Bun
    if [[ -n "$BUN_FUNCTIONS_DIR" ]]; then
        BUN_FUNC_ROOT="/opt/supabase/${BUN_FUNCTIONS_DIR}/functions"
        if [[ -d "$BUN_FUNC_ROOT" ]]; then
            BUN_MCP_DIR="$BUN_FUNC_ROOT/mcp"
            mkdir -p "$BUN_MCP_DIR"
            echo "$MCP_INDEX_TS" > "$BUN_MCP_DIR/index.ts"
            echo "$MCP_DENO_JSON" > "$BUN_MCP_DIR/deno.json"
            log_info "已部署 MCP Function 到 Bun 运行时: $BUN_MCP_DIR"
        fi
    fi
}

# ========== 显示完成信息 ==========
show_completion() {
    log_step "安装完成！"
    
    echo ""
    echo "============================================================"
    echo -e "${GREEN}Pigsty Supabase 安装成功！${NC}"
    echo "============================================================"
    echo ""
    echo "访问地址:"
    echo "  Supabase Studio: http://${INTERNAL_IP}:8000"
    echo "  Supabase Studio: https://${SUPABASE_DOMAIN} (需配置 DNS 和 HTTPS)"
    echo "  Grafana 监控:    http://${INTERNAL_IP}:3000"
    echo ""
    echo "登录凭据:"
    echo "  Supabase: ${DASHBOARD_USERNAME:-supabase} / ${DASHBOARD_PASSWORD:-pigsty}"
    echo "  Grafana:  admin / ${GRAFANA_PASSWORD:-pigsty}"
    echo ""
    echo "下一步操作:"
    echo "  1. 将域名 ${SUPABASE_DOMAIN} 的 DNS A 记录指向服务器公网 IP"
    echo "  2. 运行 'cd ~/pigsty && make cert' 申请 HTTPS 证书"
    echo ""
    echo "常用命令:"
    echo "  查看容器状态: podman ps 或 docker ps"
    echo "  查看日志: podman logs <container_name>"
    echo "  重启服务: cd ~/pigsty/app/supabase && docker-compose restart"
    echo ""
}

# ========== 主函数 ==========
main() {
    echo ""
    echo "============================================================"
    echo "  Pigsty Supabase 一键安装脚本"
    echo "  https://pigsty.cc/docs/app/supabase/"
    echo "============================================================"
    echo ""
    
    check_config
    check_system
    setup_swap
    
    # 升级网关为 OpenResty (带自动 SSL)
    install_enhanced_gateway
    
    install_container_runtime
    install_docker_compose
    install_s3_storage
    configure_edge_runtime
    install_pigsty
    deploy_mcp_function
    show_completion
}

# 运行主函数
main "$@"

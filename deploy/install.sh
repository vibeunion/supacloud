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
        # 获取所有非回环 IP，优先选择 IPv4（过滤掉包含冒号的 IPv6 地址）
        ALL_IPS=($(hostname -I 2>/dev/null))
        IPS=()
        for ip in "${ALL_IPS[@]}"; do
            # 只保留 IPv4 地址（不包含冒号）
            if [[ ! "$ip" =~ : ]]; then
                IPS+=("$ip")
            fi
        done
        # 如果没有 IPv4，则使用所有 IP
        if [[ ${#IPS[@]} -eq 0 ]]; then
            IPS=("${ALL_IPS[@]}")
        fi
        
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

    # 3. 检查并生成随机密码 (如果使用默认值)
    if [[ -z "$POSTGRES_PASSWORD" || "$POSTGRES_PASSWORD" == "DBUser.Supa" ]]; then
        log_info "检测到默认数据库密码，正在生成随机强密码..."
        POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)
        log_info "已生成数据库密码"
    fi

    if [[ -z "$DASHBOARD_PASSWORD" || "$DASHBOARD_PASSWORD" == "supacloud" ]]; then
        log_info "检测到默认 Studio 密码，正在生成随机强密码..."
        DASHBOARD_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)
        log_info "已生成 Studio 密码"
    fi
    
    if [[ -z "$GRAFANA_PASSWORD" || "$GRAFANA_PASSWORD" == "supacloud" ]]; then
        log_info "检测到默认 Grafana 密码，正在生成随机强密码..."
        GRAFANA_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)
        log_info "已生成 Grafana 密码"
    fi
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
    
    # 优先使用 gh-proxy.net 代理加速下载
    log_info "使用 gh-proxy.net 代理加速下载..."
    if curl -L --progress-bar "https://gh-proxy.net/$COMPOSE_URL" -o /usr/local/bin/docker-compose; then
        log_info "代理下载成功"
    else
        log_warn "代理下载失败，尝试直接下载..."
        curl -L --progress-bar "$COMPOSE_URL" -o /usr/local/bin/docker-compose
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
    
    case "${S3_STORAGE_TYPE:-rustfs}" in
        minio)
            log_info "使用 Pigsty 内置 MinIO，无需额外安装"
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
# ========== 安装 Garage (已移除) ==========

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
    
    # 下载 RustFS（使用代理加速）
    if [[ ! -f /usr/local/bin/rustfs ]]; then
        log_info "下载 RustFS ${RUSTFS_VERSION}（使用 gh-proxy.net 加速）..."
        cd /tmp
        if curl -L --progress-bar "https://gh-proxy.net/$RUSTFS_URL" -o rustfs.tar.gz; then
            log_info "代理下载成功"
        else
            log_warn "代理下载失败，尝试直接下载..."
            curl -L --progress-bar "$RUSTFS_URL" -o rustfs.tar.gz
        fi
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
# ========== 安装 Nginx Mainline (带 ACME 模块) ==========
install_nginx_mainline() {
    log_step "正在安装 Nginx Mainline (带 ACME 模块)..."

    # 识别操作系统
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        DISTRO_ID="${ID,,}"
        DISTRO_CODENAME="${VERSION_CODENAME}"
        DISTRO_VERSION_ID="${VERSION_ID%%.*}"
    fi

    log_info "检测到系统: $DISTRO_ID $DISTRO_VERSION_ID"

    case "$DISTRO_ID" in
        # RHEL 系列
        rocky|almalinux|opencloudos|centos|rhel|anolis|tencentos)
            log_info "配置 Nginx Mainline 仓库 (RHEL/CentOS)..."
            
            # 创建 repo 文件
            cat > /etc/yum.repos.d/nginx.repo << EOF
[nginx-mainline]
name=nginx mainline repo
baseurl=http://nginx.org/packages/mainline/centos/\$releasever/\$basearch/
gpgcheck=1
enabled=1
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true
EOF
            
            log_info "安装 Nginx 和 ACME 模块..."
            if command -v dnf &> /dev/null; then
                dnf install -y nginx nginx-module-acme
            else
                yum install -y nginx nginx-module-acme
            fi
            ;;
        
        # Debian/Ubuntu 系列
        debian|ubuntu)
            log_info "配置 Nginx Mainline 仓库 (Debian/Ubuntu)..."
            
            # 安装依赖
            apt-get update
            apt-get install -y curl gnupg2 ca-certificates lsb-release ubuntu-keyring

            # 添加 Key
            curl https://nginx.org/keys/nginx_signing.key | gpg --dearmor \
                | tee /usr/share/keyrings/nginx-archive-keyring.gpg >/dev/null

            # 添加源
            echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] \
            http://nginx.org/packages/mainline/${DISTRO_ID} \
            $(lsb_release -cs) nginx" \
            | tee /etc/apt/sources.list.d/nginx.list

            # 设置优先级 (确保安装官方包而非系统包)
            echo -e "Package: *\nPin: origin nginx.org\nPin-Priority: 900\n" \
                | tee /etc/apt/preferences.d/99nginx

            # 增加重试逻辑，防止 nginx.org 连接失败
            local retry_count=0
            local max_retries=3
            while [ $retry_count -lt $max_retries ]; do
                if apt-get update && apt-get install -y nginx nginx-module-acme; then
                    log_info "Nginx 安装成功"
                    break
                else
                    retry_count=$((retry_count + 1))
                    log_warn "Nginx 仓库更新失败，正在进行第 $retry_count 次重试..."
                    sleep 5
                fi
                if [ $retry_count -eq $max_retries ]; then
                    log_error "Nginx 仓库 $(lsb_release -cs) 无法连接，请检查网络或 nginx.org 状态"
                    log_warn "尝试跳过仓库更新，使用系统默认仓库继续（可能缺少 ACME 模块）..."
                    apt-get install -y nginx || true
                fi
            done
            ;;
        
        *)
            log_error "不支持的操作系统: $DISTRO_ID"
            exit 1
            ;;
    esac

    # 启用 Nginx
    systemctl enable nginx
    
    log_info "Nginx 安装完成"
}



# ========== 注入 Lua 自动 SSL 逻辑到 Pigsty 模板 (已弃用) ==========
inject_lua_config() {
    log_info "跳过模板注入，将在安装后直接应用最终配置..."
    log_info "跳过模板注入，将在安装后直接应用最终配置..."
    # 我们改用 apply_nginx_acme_config 直接覆盖配置，更加稳健
    return 0
}

# ========== 执行 Nginx 二进制劫持 ==========
# ========== 应用 Nginx ACME 配置 ==========
apply_nginx_acme_config() {
    log_step "应用 Nginx 配置 (原生 ACME 模块)..."
    
    # 确保 modules 目录存在 (防止某些发行版路径差异)
    # 通常在 /usr/lib/nginx/modules 或 /etc/nginx/modules
    
    NGINX_CONF="/etc/nginx/nginx.conf"
    
    # 备份旧配置
    if [[ -f "$NGINX_CONF" ]]; then
        cp "$NGINX_CONF" "${NGINX_CONF}.bak.$(date +%s)"
    fi

    # 查找 ACME 模块路径
    ACME_MODULE_PATH=$(find /usr/lib/nginx/modules /usr/lib64/nginx/modules /etc/nginx/modules -name "ngx_http_acme_module.so" 2>/dev/null | head -1)
    
    if [[ -z "$ACME_MODULE_PATH" ]]; then
        # 如果找不到，尝试直接引用文件名，指望它在默认路径
        ACME_MODULE_PATH="ngx_http_acme_module.so"
        log_warn "未找到 ngx_http_acme_module.so 绝对路径，尝试直接加载..."
    else
        log_info "发现 ACME 模块: $ACME_MODULE_PATH"
    fi

    # 生成最终的 nginx.conf
    cat > "$NGINX_CONF" << EOF
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /var/run/nginx.pid;

# 加载 ACME 模块
load_module "$ACME_MODULE_PATH";

events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    
    log_format  main  '\$remote_addr - \$remote_user [\$time_local] "\$request" '
                      '\$status \$body_bytes_sent "\$http_referer" '
                      '"\$http_user_agent" "\$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    sendfile        on;
    keepalive_timeout  65;

    # --- ACME 全局配置 ---
    resolver 8.8.8.8 1.1.1.1 valid=300s;
    
    acme_issuer letsencrypt {
        uri https://acme-v02.api.letsencrypt.org/directory;
        # uri https://acme-staging-v02.api.letsencrypt.org/directory; # 测试用
        
        # 必须配置 ecdsa (ECC) 密钥，支持 256/384
        account_key ecdsa:256;
        
        # 使用 HTTP-01 验证 (Nginx 原生支持)
        challenge http-01;
    }

    # 后端定义
    upstream studio_backend {
        server 127.0.0.1:3003;
    }
    
    upstream kong_backend {
        server 127.0.0.1:8000;
    }

    # HTTP Server (Redirect + ACME Challenge)
    server {
        listen 80;
        server_name ${SUPABASE_STUDIO_DOMAIN} ${SUPABASE_PUBLIC_DOMAIN};
        
        # ACME 模块会自动处理 /.well-known/acme-challenge/
        # 无需手动配置 location
        
        location / {
            return 301 https://\$host\$request_uri;
        }
    }

    # Studio HTTPS
    server {
        listen 443 ssl;
        server_name ${SUPABASE_STUDIO_DOMAIN};
        
        # 启用 ACME 证书管理
        acme_certificate letsencrypt;
        
        # 使用变量引用生成的证书
        ssl_certificate     \$acme_certificate;
        ssl_certificate_key \$acme_certificate_key;
        
        # 推荐的 SSL 设置
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        
        location / {
            proxy_pass http://studio_backend;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection "upgrade";
        }
    }
    
    # API HTTPS
    server {
        listen 443 ssl;
        server_name ${SUPABASE_PUBLIC_DOMAIN};
        
        acme_certificate letsencrypt;
        ssl_certificate     \$acme_certificate;
        ssl_certificate_key \$acme_certificate_key;
        
        location / {
            proxy_pass http://kong_backend;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection "upgrade";
        }
    }
}
EOF

    log_info "验证 Nginx 配置..."
    if nginx -t; then
        log_info "配置验证通过，重启 Nginx 服务..."
        systemctl restart nginx
        
        # 等待 ACME 证书申请 (首次启动可能需要一点时间)
        log_info "Nginx 已启动，正在后台自动申请证书..."
    else
        log_error "Nginx 配置验证失败！"
        nginx -t
        exit 1
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
        # 简单校验 v4
        if [[ ! -f "$HOME/pigsty/infra.yml" ]]; then
             log_warn "Pigsty 目录存在但缺少 infra.yml，尝试重新下载..."
             rm -rf "$HOME/pigsty"
             curl -fsSL https://repo.pigsty.cc/get | bash
        fi
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
    
    # 放宽 Supabase 启动时的健康检查限制 (提前应用，防止 app.yml 阻塞)
    # 覆盖 Pigsty 模板中的 healthcheck 设置
    log_info "预防性放宽 Supabase 模板中的健康检查限制..."
    find app/supabase -name "docker-compose.yml" -o -name "docker-compose.yaml" | xargs -r sed -i 's/condition: service_healthy/condition: service_started/g'
    
    # 精简 Analytics 服务 (如果未启用)
    if [[ "${ENABLE_ANALYTICS:-off}" != "on" ]]; then
        log_info "正在精简/优化 Analytics 服务 (模式: ${ENABLE_ANALYTICS:-off})..."
        find app/supabase -name "docker-compose.yml" -o -name "docker-compose.yaml" | while read -r f; do
            # 始终移除 ClickHouse (analytics服务)
            sed -i '/analytics:/,/^[a-zA-Z]/ { /analytics:/d; /^[a-zA-Z]/!d }' "$f"
            sed -i '/- analytics/d' "$f"
            
            if [[ "${ENABLE_ANALYTICS}" == "postgres" ]]; then
                log_info "配置轻量级 Postgres 日志存储 (Studio 兼容性处理)..."
                # 调整 Logflare 环境以使用 Postgres (如果支持) 
                # 或者在 Studio 中设置 LOGFLARE_URL 为模拟端点
                # 这里简单处理：保留 Logflare 容器但禁用其对 ClickHouse 的依赖
                sed -i 's/LOGFLARE_URL: http:\/\/analytics:5432/LOGFLARE_URL: http:\/\/supabase-db:5432/g' "$f"
                
                # 配置 Vector 将日志写入 Postgres
                local vector_cfg_path="$(dirname "$f")/vector/vector.yaml"
                mkdir -p "$(dirname "$vector_cfg_path")"
                
                log_info "注入 Vector Postgres Sink 配置: $vector_cfg_path"
                cat > "$vector_cfg_path" << EOF
sources:
  docker_logs:
    type: docker_logs

transforms:
  enriched_logs:
    type: remap
    inputs: ["docker_logs"]
    source: |
      .timestamp = .timestamp || now()
      .level = .level || "info"
      .event_message = .message
      .metadata = {
        "container_name": .container_name,
        "image": .image,
        "host": .host
      }
      del(.message)

sinks:
  postgres:
    type: postgresql
    inputs: ["enriched_logs"]
    connection_string: "postgresql://postgres:${POSTGRES_PASSWORD}@${INTERNAL_IP}:5432/postgres"
    schema: "logs"
    table: "entries"
    batch:
      max_events: 50
EOF
            else
                # 完全移除 Logflare 和 Vector
                sed -i '/logflare:/,/^[a-zA-Z]/ { /logflare:/d; /^[a-zA-Z]/!d }' "$f"
                sed -i '/vector:/,/^[a-zA-Z]/ { /vector:/d; /^[a-zA-Z]/!d }' "$f"
                sed -i '/- logflare/d' "$f"
            fi
        done
        log_info "Analytics 服务精简完成 (${ENABLE_ANALYTICS})"
    fi
    
    # 安装 Pigsty
    log_info "安装 Pigsty (这可能需要 10-20 分钟)..."
    # 安装 Pigsty v4 基础设置
    log_info "安装 Pigsty Infra (v4)..."
    if [[ -f "infra.yml" ]]; then
        ansible-playbook infra.yml
    else
        log_error "找不到 infra.yml (Pigsty v4 核心 Playbook)，路径: $(pwd)"
        ls -la
        exit 1
    fi
    
    # 安装 Docker
    log_info "配置 Docker..."
    if [[ -f "docker.yml" ]]; then
        ansible-playbook docker.yml || true
    fi
    
    # 启动 Supabase
    log_info "启动 Supabase..."
    if [[ -f "app.yml" ]]; then
        ansible-playbook app.yml || {
            log_warn "app.yml 失败，尝试手动启动..."
            manual_start_supabase
        }
    fi
}

# ========== 更新 Pigsty 配置 ==========
update_pigsty_config() {
    log_step "更新 Pigsty 配置..."
    
    PIGSTY_YML=~/pigsty/pigsty.yml
    
    # 强制替换默认 IP (修复可能未替换的 Bug)
    if [[ -n "$INTERNAL_IP" ]]; then
        sed -i "s|10.6.0.9|${INTERNAL_IP}|g" "$PIGSTY_YML"
    fi
    
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
    
    # 更新密码配置
    if [[ -n "$DASHBOARD_PASSWORD" && "$DASHBOARD_PASSWORD" != "your-strong-password" ]]; then
        sed -i "s|DASHBOARD_PASSWORD: pigsty|DASHBOARD_PASSWORD: ${DASHBOARD_PASSWORD}|g" "$PIGSTY_YML"
    fi
    
    # 自动生成 Postgres 密码 (如果未设置)
    if [[ -z "$POSTGRES_PASSWORD" || "$POSTGRES_PASSWORD" == "DBUser.Supa" ]]; then
        log_info "自动生成 PostgreSQL 强密码..."
        POSTGRES_PASSWORD=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9')
        log_info "生成的 Postgres 密码: ${POSTGRES_PASSWORD}"
        
        # 保存到 install.conf (如果有的话) 或输出到文件以便后续查看
        echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" >> ~/supacloud_credentials.env
    fi

    # 更新 Pigsty 配置文件中的 Postgres 密码
    sed -i "s|POSTGRES_PASSWORD: DBUser.Supa|POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}|g" "$PIGSTY_YML"
    
    # 同时更新 Supabase .env (如果存在)
    if [[ -f ~/pigsty/app/supabase/.env ]]; then
         sed -i "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|g" ~/pigsty/app/supabase/.env
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
    
    if [[ "${S3_STORAGE_TYPE:-minio}" != "minio" ]]; then
        configure_s3_in_pigsty
    fi
    
    # 修复 Analytics (Logflare) 健康检查失败问题
    # Logflare 需要 LOGFLARE_API_KEY 才能正常启动
    if ! grep -q "LOGFLARE_API_KEY:" "$PIGSTY_YML"; then
        log_info "注入 LOGFLARE_API_KEY 以修复 Analytics 启动..."
        # 生成一个随机 Key
        local lf_key=$(openssl rand -hex 16)
        # 追加到文件末尾 (或者替换如果存在但为空)
        echo "LOGFLARE_API_KEY: ${lf_key}" >> "$PIGSTY_YML"
        
        # 同时更新 Supabase .env (如果存在)
        if [[ -f ~/pigsty/app/supabase/.env ]]; then
             sed -i "s|LOGFLARE_API_KEY=.*|LOGFLARE_API_KEY=${lf_key}|g" ~/pigsty/app/supabase/.env
             # 如果 .env 中没有这个变量，追加它
             if ! grep -q "LOGFLARE_API_KEY" ~/pigsty/app/supabase/.env; then
                 echo "LOGFLARE_API_KEY=${lf_key}" >> ~/pigsty/app/supabase/.env
             fi
        fi
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
    
    # 确保 LOGFLARE_API_KEY 存在 (再次检查)
    if ! grep -q "LOGFLARE_API_KEY" .env; then
         echo "LOGFLARE_API_KEY=$(openssl rand -hex 16)" >> .env
    fi
    
    # 放宽 Supabase 启动时的健康检查限制 (防止 Analytics/Logflare 阻塞所有服务)
    # 将所有 condition: service_healthy 替换为 condition: service_started
    if [[ -f docker-compose.yml ]]; then
        log_info "放宽 docker-compose.yml 健康检查限制..."
        sed -i 's/condition: service_healthy/condition: service_started/g' docker-compose.yml
    fi
    
    # 启动服务
    if docker compose version &> /dev/null; then
        docker compose up -d
    elif command -v docker-compose &> /dev/null; then
        docker-compose up -d
    else
        log_error "未找到 docker compose 或 docker-compose 命令，无法启动 Supabase"
        return 1
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

# ========== 部署 Supacloud Manager ==========
install_manager() {
    log_step "安装 Supacloud Manager..."

    # 1. 确定安装源和目标
    REPO_ROOT="$(dirname "$SCRIPT_DIR")"
    INSTALL_DIR="/opt/supacloud"
    BIN_SOURCE="$REPO_ROOT/bin/supacloud-linux-x64"

    # 检查二进制文件是否存在
    if [[ ! -f "$BIN_SOURCE" ]]; then
        log_warn "未找到 Manager二进制文件: $BIN_SOURCE"
        log_warn "尝试自动构建 (需要 Bun)..."
        
        if command -v bun &> /dev/null; then
             cd "$REPO_ROOT/manager"
             bun install
             bun run build
             cd -
        else
            log_error "未找到 Bun，且没有预编译的二进制文件。跳过 Manager 安装。"
            return 1
        fi
    fi

    # 2. 准备目录
    mkdir -p "$INSTALL_DIR/bin"
    mkdir -p "$INSTALL_DIR/instances"
    mkdir -p "$INSTALL_DIR/run" # PID file etc

    # 3. 复制文件
    log_info "复制文件到 $INSTALL_DIR..."
    cp "$BIN_SOURCE" "$INSTALL_DIR/bin/supacloud"
    chmod +x "$INSTALL_DIR/bin/supacloud"

    # 复制 templates (包含 project 和 base 模板)
    if [[ -d "$REPO_ROOT/templates" ]]; then
        rm -rf "$INSTALL_DIR/templates"
        cp -r "$REPO_ROOT/templates" "$INSTALL_DIR/"
    else
        log_error "找不到 templates 目录！"
        return 1
    fi

    # 4. 创建 Systemd 服务
    cat > /etc/systemd/system/supacloud-manager.service << EOF
[Unit]
Description=Supacloud Multi-tenant Manager
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
Environment="SUPACLOUD_HOME=$INSTALL_DIR"
Environment="NODE_ENV=production"
Environment="PORT=8888"
# 如果使用 bun 运行源码:
# ExecStart=/usr/local/bin/bun run $INSTALL_DIR/manager/index.tsx
# 使用编译后的二进制:
ExecStart=$INSTALL_DIR/bin/supacloud start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

    # 5. 启动服务
    systemctl daemon-reload
    systemctl enable --now supacloud-manager
    
    # 等待启动并检查
    sleep 3
    if systemctl is-active --quiet supacloud-manager; then
        log_info "Supacloud Manager 已启动 (端口 8888)"
    else
        log_error "Supacloud Manager 启动失败，请检查: systemctl status supacloud-manager"
    fi
}

# ========== 配置 WAL 日志监控与自动清理 ==========
setup_wal_monitor() {
    log_step "配置 WAL 日志监控与预防机制..."
    
    # 1. 创建自动清理脚本
    cat > /usr/local/bin/clean_inactive_wal_slots.sh << 'EOF'
#!/bin/bash
# 自动清理 PostgreSQL 无效复制槽以防止 WAL 爆满
# 由 install.sh 自动生成，支持 Pigsty 本地部署和 Docker 容器部署

LOG_FILE="/var/log/wal_cleaner.log"

# 定义执行 SQL 的函数
run_sql() {
    local sql="$1"
    
    # 1. 尝试 Pigsty / 本地 Postgres 用户方式
    if id "postgres" &>/dev/null && pgrep -u postgres postgres &>/dev/null; then
        su - postgres -c "psql -d postgres -t -c \"$sql\"" 2>>"$LOG_FILE"
        return $?
    fi
    
    # 2. 尝试 Docker 容器
    if command -v docker &>/dev/null && docker ps | grep -q "supabase-db"; then
        docker exec supabase-db psql -U postgres -d postgres -t -c "$sql" 2>>"$LOG_FILE"
        return $?
    fi
    
    # 3. 尝试 Podman 容器
    if command -v podman &>/dev/null && podman ps | grep -q "supabase-db"; then
        podman exec supabase-db psql -U postgres -d postgres -t -c "$sql" 2>>"$LOG_FILE"
        return $?
    fi
    
    echo "Error: No database connection method found." >> "$LOG_FILE"
    return 1
}

# 获取无效且长期未活动的槽位 (active=f)
SLOTS=$(run_sql "SELECT slot_name FROM pg_replication_slots WHERE active = 'f';")

for slot in $SLOTS; do
    # 去除空格和换行
    slot=$(echo "$slot" | xargs)
    if [[ -n "$slot" ]]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [WARN] 发现不活动复制槽: $slot，正在删除..." >> "$LOG_FILE"
        
        # 删除命令需要转义引号，稍微复杂一点，直接再次调用 run_sql
        if run_sql "SELECT pg_drop_replication_slot('$slot');"; then
             echo "$(date '+%Y-%m-%d %H:%M:%S') [INFO] 成功删除复制槽: $slot" >> "$LOG_FILE"
             # 触发检查点以立即释放空间
             run_sql "CHECKPOINT;"
        else
             echo "$(date '+%Y-%m-%d %H:%M:%S') [ERROR] 删除复制槽失败: $slot" >> "$LOG_FILE"
        fi
    fi
done
EOF

    chmod +x /usr/local/bin/clean_inactive_wal_slots.sh
    
    # 2. 添加定时任务 (Cron) - 每小时执行一次
    if command -v crontab &> /dev/null; then
        if ! crontab -l 2>/dev/null | grep -q "clean_inactive_wal_slots.sh"; then
            (crontab -l 2>/dev/null; echo "0 * * * * /usr/local/bin/clean_inactive_wal_slots.sh") | crontab -
            log_info "已添加定时任务: 每小时清理无效复制槽"
        else
            log_info "定时任务已存在，通过检查"
        fi
    else
        log_warn "未找到 crontab，无法配置自动清理任务，请手动安装 cronie"
    fi
    
    # 3. 预防性配置: max_slot_wal_keep_size (PostgreSQL 13+)
    log_info "配置 PostgreSQL max_slot_wal_keep_size 防护 (异步执行)..."
    
    (
        sleep 60
        # 尝试配置，支持本地和容器
        CONFIG_SQL="ALTER SYSTEM SET max_slot_wal_keep_size = '10GB'; SELECT pg_reload_conf();"
        
        if id "postgres" &>/dev/null; then
            su - postgres -c "psql -c \"$CONFIG_SQL\""
        elif command -v docker &>/dev/null && docker ps | grep -q "supabase-db"; then
            docker exec supabase-db psql -U postgres -c "$CONFIG_SQL"
        elif command -v podman &>/dev/null && podman ps | grep -q "supabase-db"; then
            podman exec supabase-db psql -U postgres -c "$CONFIG_SQL"
        fi
        
        echo "Postgres WAL protection configured." >> /var/log/wal_cleaner.log
    ) > /dev/null 2>&1 &
}

# ========== 配置 PG HBA 白名单 ==========
configure_pg_hba() {
    log_step "配置数据库访问白名单 (pg_hba.conf)..."

    # 1. 识别容器网络网段
    # 尝试检测 cni-podman0 (Podman) 或 docker0 (Docker)
    CONTAINER_NET=""
    
    if ip addr show cni-podman0 &> /dev/null; then
        CONTAINER_NET=$(ip -o -4 addr show cni-podman0 | awk '{print $4}')
        log_info "发现 Podman 网络: ${CONTAINER_NET}"
    elif ip addr show docker0 &> /dev/null; then
        CONTAINER_NET=$(ip -o -4 addr show docker0 | awk '{print $4}')
        log_info "发现 Docker 网络: ${CONTAINER_NET}"
    else
        # 尝试智能猜测，查找 10.88/16, 10.89/24 等常见网段
        CONTAINER_NET=$(ip route | grep "link src" | grep -E "10\.(88|89)\." | awk '{print $1}' | head -1)
    fi

    if [[ -z "$CONTAINER_NET" ]]; then
        # 兜底：默认 Podman 网段
        CONTAINER_NET="10.88.0.0/16" 
        log_warn "未检测到容器网络，使用默认值: ${CONTAINER_NET}"
    fi

    # 2. 定位 pg_hba.conf
    # Pigsty 默认路径
    PG_HBA="/pg/data/pg_hba.conf"
    
    if [[ ! -f "$PG_HBA" ]]; then
        log_warn "未找到 $PG_HBA，试图查找其他位置..."
        # 尝试查找 Debian/Ubuntu 或 RHEL 默认路径
        POSSIBLE_PATHS=(
            "/var/lib/postgresql/data/pg_hba.conf"
            "/var/lib/pgsql/data/pg_hba.conf"
            "/etc/postgresql/14/main/pg_hba.conf"
            "/etc/postgresql/15/main/pg_hba.conf"
        )
        for path in "${POSSIBLE_PATHS[@]}"; do
            if [[ -f "$path" ]]; then
                PG_HBA="$path"
                log_info "找到 pg_hba.conf: $PG_HBA"
                break
            fi
        done
    fi

    if [[ ! -f "$PG_HBA" ]]; then
        log_warn "最终未找到 pg_hba.conf，跳过配置"
        return
    fi
    
    # 3. 添加规则
    # host all all <CIDR> scram-sha-256
    CONFIG_LINE="host all all ${CONTAINER_NET} scram-sha-256"
    
    if grep -qF "$CONTAINER_NET" "$PG_HBA"; then
        log_info "规则已存在: $CONFIG_LINE"
    else
        log_info "添加规则: $CONFIG_LINE"
        # 备份
        cp "$PG_HBA" "${PG_HBA}.bak.$(date +%s)"
        # 添加到文件末尾
        echo "$CONFIG_LINE" >> "$PG_HBA"
        
        # 4. 重载配置
        log_info "重载 PostgreSQL 配置..."
        if command -v pg_ctl &> /dev/null; then
             # 需要切换到 postgres 用户执行
             su - postgres -c "pg_ctl reload -D $(dirname "$PG_HBA")"
        elif systemctl is-active --quiet postgresql; then
             systemctl reload postgresql
        elif systemctl is-active --quiet patroni; then
             systemctl reload patroni
        elif pgrep -u postgres postgres > /dev/null; then
             # 尝试发送 SIGHUP
             pkill -HUP -u postgres postgres
             log_info "已发送 SIGHUP 信号给 postgres 进程"
        else
             log_warn "无法自动重载 PostgreSQL，请手动执行重载命令生效"
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
    
    # 安装 Nginx Mainline + ACME 模块
    install_nginx_mainline
    
    install_container_runtime
    install_docker_compose
    install_s3_storage
    configure_edge_runtime
    install_pigsty
    deploy_mcp_function
    install_manager
    setup_wal_monitor
    configure_pg_hba
    
    # 在所有安装完成后，应用最终的网关路由和 SSL 配置
    apply_nginx_acme_config
    
    show_completion
}

# 运行主函数
main "$@"

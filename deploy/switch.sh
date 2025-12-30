#!/bin/bash
# ============================================================
# Supabase 运行时切换脚本
# 用于在部署后切换 Edge Functions 运行时和 S3 存储
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# 显示帮助
show_help() {
    echo "Supabase 运行时切换工具"
    echo ""
    echo "用法: $0 <command> [options]"
    echo ""
    echo "命令:"
    echo "  runtime <deno|bun>     切换 Edge Functions 运行时"
    echo "  storage <type>         切换 S3 存储类型"
    echo "  status                 显示当前配置"
    echo ""
    echo "存储类型:"
    echo "  minio                  使用 MinIO (Pigsty 默认)"
    echo "  garage                 使用 Garage S3"
    echo "  rustfs                 使用 RustFS"
    echo "  external               使用外部 S3 (需要额外配置)"
    echo ""
    echo "示例:"
    echo "  $0 runtime bun         切换到 Bun 运行时"
    echo "  $0 runtime deno        切换到 Deno 运行时"
    echo "  $0 storage garage      切换到 Garage S3"
    echo "  $0 status              显示当前状态"
    echo ""
}

# 显示当前状态
show_status() {
    log_step "当前配置状态"
    echo ""
    
    # Edge Functions 运行时
    echo "Edge Functions 运行时:"
    if [[ -f /etc/supabase/.use_bun_runtime ]]; then
        echo -e "  当前: ${GREEN}Bun${NC}"
        if command -v podman &> /dev/null; then
            podman ps --filter "name=bun-functions" --format "  容器状态: {{.Status}}" 2>/dev/null || echo "  容器状态: 未运行"
        elif command -v docker &> /dev/null; then
            docker ps --filter "name=bun-functions" --format "  容器状态: {{.Status}}" 2>/dev/null || echo "  容器状态: 未运行"
        fi
    else
        echo -e "  当前: ${GREEN}Deno${NC} (官方默认)"
        if command -v podman &> /dev/null; then
            podman ps --filter "name=edge-functions" --format "  容器状态: {{.Status}}" 2>/dev/null || echo "  容器状态: 未运行"
        fi
    fi
    echo ""
    
    # S3 存储
    echo "S3 存储:"
    if [[ -f /etc/supabase/bun-functions.env ]]; then
        source /etc/supabase/bun-functions.env 2>/dev/null || true
    fi
    
    if systemctl is-active --quiet garage 2>/dev/null; then
        echo -e "  当前: ${GREEN}Garage${NC}"
        echo "  端口: 3900"
    elif systemctl is-active --quiet rustfs 2>/dev/null; then
        echo -e "  当前: ${GREEN}RustFS${NC}"
        echo "  端口: 9000"
    elif systemctl is-active --quiet minio 2>/dev/null; then
        echo -e "  当前: ${GREEN}MinIO${NC}"
    else
        echo "  当前: 外部 S3 或未配置"
    fi
    echo ""
    
    # 显示凭据位置
    echo "配置文件位置:"
    echo "  JWT 密钥: /etc/supabase/jwt-keys.env"
    [[ -f /etc/garage/s3-credentials.env ]] && echo "  Garage 凭据: /etc/garage/s3-credentials.env"
    [[ -f /etc/rustfs-credentials.env ]] && echo "  RustFS 凭据: /etc/rustfs-credentials.env"
    echo ""
}

# 切换 Edge Functions 运行时
switch_runtime() {
    local runtime=$1
    
    case "$runtime" in
        deno)
            switch_to_deno
            ;;
        bun)
            switch_to_bun
            ;;
        *)
            log_error "未知的运行时: $runtime"
            log_info "支持的运行时: deno, bun"
            exit 1
            ;;
    esac
}

# 切换到 Deno
switch_to_deno() {
    log_step "切换到 Deno 运行时..."
    
    # 停止 Bun 容器
    if command -v podman &> /dev/null; then
        podman stop supabase-bun-functions 2>/dev/null || true
        podman rm supabase-bun-functions 2>/dev/null || true
    elif command -v docker &> /dev/null; then
        docker stop supabase-bun-functions 2>/dev/null || true
        docker rm supabase-bun-functions 2>/dev/null || true
    fi
    
    # 移除 Bun 标记
    rm -f /etc/supabase/.use_bun_runtime
    
    # 重启 Supabase 容器以使用默认 Deno edge-runtime
    cd ~/pigsty/app/supabase
    if command -v docker-compose &> /dev/null; then
        docker-compose up -d supabase-edge-functions
    else
        /usr/local/bin/docker-compose up -d supabase-edge-functions
    fi
    
    log_info "已切换到 Deno 运行时"
    log_info "Edge Functions API: http://localhost:9000/functions/v1/{function}"
}

# 切换到 Bun
switch_to_bun() {
    log_step "切换到 Bun 运行时..."
    
    # 检查 Bun 容器是否已构建
    BUN_FUNCTIONS_DIR="/opt/supabase/bun-functions"
    
    if [[ ! -d "$BUN_FUNCTIONS_DIR" ]]; then
        log_error "Bun 函数目录不存在: $BUN_FUNCTIONS_DIR"
        log_info "请先运行安装脚本并设置 EDGE_RUNTIME=bun"
        exit 1
    fi
    
    # 停止 Deno 容器
    if command -v podman &> /dev/null; then
        podman stop supabase-edge-functions 2>/dev/null || true
    elif command -v docker &> /dev/null; then
        docker stop supabase-edge-functions 2>/dev/null || true
    fi
    
    # 加载 JWT 密钥
    if [[ -f /etc/supabase/jwt-keys.env ]]; then
        set -a
        source /etc/supabase/jwt-keys.env
        set +a
    fi
    
    # 启动 Bun 容器
    cd "$BUN_FUNCTIONS_DIR"
    if command -v docker-compose &> /dev/null; then
        docker-compose up -d --build
    elif command -v podman &> /dev/null; then
        podman build -t supabase-bun-functions .
        podman run -d --name supabase-bun-functions \
            --restart unless-stopped \
            -p 9001:9001 \
            -e PORT=9001 \
            -e JWT_SECRET="${JWT_SECRET}" \
            -e ANON_KEY="${ANON_KEY}" \
            -e SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}" \
            -v ./functions:/app/functions:ro \
            --network supabase_default \
            supabase-bun-functions
    fi
    
    # 创建 Bun 标记
    touch /etc/supabase/.use_bun_runtime
    
    log_info "已切换到 Bun 运行时"
    log_info "Edge Functions API: http://localhost:9001/{function}"
}

# 切换 S3 存储
switch_storage() {
    local storage_type=$1
    
    case "$storage_type" in
        minio)
            switch_to_minio
            ;;
        garage)
            switch_to_garage
            ;;
        rustfs)
            switch_to_rustfs
            ;;
        external)
            configure_external_s3
            ;;
        *)
            log_error "未知的存储类型: $storage_type"
            log_info "支持的类型: minio, garage, rustfs, external"
            exit 1
            ;;
    esac
}

# 切换到 MinIO
switch_to_minio() {
    log_step "切换到 MinIO..."
    
    # 停止其他 S3 服务
    systemctl stop garage 2>/dev/null || true
    systemctl stop rustfs 2>/dev/null || true
    
    # MinIO 通常由 Pigsty 管理
    log_info "MinIO 由 Pigsty 管理"
    log_info "请确保 Pigsty MinIO 服务正在运行"
    log_info "运行: cd ~/pigsty && ./minio.yml"
    
    log_info "已切换到 MinIO"
}

# 切换到 Garage
switch_to_garage() {
    log_step "切换到 Garage S3..."
    
    # 停止其他 S3 服务
    systemctl stop rustfs 2>/dev/null || true
    
    # 尝试停止 MinIO (如果存在)
    log_info "检查 MinIO 容器..."
    if command -v docker &> /dev/null; then
        docker stop minio 2>/dev/null || true
        docker rm minio 2>/dev/null || true
    elif command -v podman &> /dev/null; then
        podman stop minio 2>/dev/null || true
        podman rm minio 2>/dev/null || true
    fi
    
    # 检查 Garage 是否已安装
    if ! command -v garage &> /dev/null; then
        log_warn "Garage 未安装，正在安装..."
        # 这里可以调用安装函数，或者提示用户重新运行安装脚本
        log_info "请运行: S3_STORAGE_TYPE=garage ./install.sh"
        exit 1
    fi
    
    # 启动 Garage
    systemctl enable --now garage
    systemctl restart garage
    
    # 等待 Garage 启动
    log_info "等待 Garage 启动..."
    sleep 5
    if ! systemctl is-active --quiet garage; then
        log_error "Garage 启动失败，请检查日志: journalctl -u garage -n 20"
        exit 1
    fi
    
    # 获取内网 IP
    INTERNAL_IP=$(hostname -I | awk '{print $1}')
    
    # 更新 Supabase 配置
    update_supabase_s3_config "garage" "http://${INTERNAL_IP}:3900" "garage"
    
    log_info "已切换到 Garage S3"
    log_info "S3 端点: http://${INTERNAL_IP}:3900"
    log_info "凭据: /etc/garage/s3-credentials.env"
}

# 切换到 RustFS
switch_to_rustfs() {
    log_step "切换到 RustFS..."
    
    # 停止其他 S3 服务
    systemctl stop garage 2>/dev/null || true
    
    # 检查 RustFS 是否已安装
    if ! command -v rustfs &> /dev/null; then
        log_warn "RustFS 未安装，正在安装..."
        log_info "请运行: S3_STORAGE_TYPE=rustfs ./install.sh"
        exit 1
    fi
    
    # 启动 RustFS
    systemctl enable --now rustfs
    
    # 更新 Supabase 配置
    if [[ -f /etc/rustfs-credentials.env ]]; then
        source /etc/rustfs-credentials.env
        update_supabase_s3_config "rustfs" "$S3_ENDPOINT" "$S3_REGION"
    fi
    
    log_info "已切换到 RustFS"
    log_info "S3 端点: http://localhost:9000"
    log_info "凭据: /etc/rustfs-credentials.env"
}

# 配置外部 S3
configure_external_s3() {
    log_step "配置外部 S3..."
    
    echo ""
    echo "请输入外部 S3 配置:"
    read -p "S3 端点 URL: " S3_ENDPOINT
    read -p "S3 区域: " S3_REGION
    read -p "Access Key: " S3_ACCESS_KEY
    read -sp "Secret Key: " S3_SECRET_KEY
    echo ""
    read -p "Bucket 名称: " S3_BUCKET
    
    # 保存配置
    cat > /etc/supabase/external-s3.env << EOF
# 外部 S3 配置
S3_ENDPOINT=${S3_ENDPOINT}
S3_REGION=${S3_REGION}
S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}
S3_BUCKET=${S3_BUCKET}
EOF
    chmod 600 /etc/supabase/external-s3.env
    
    # 停止本地 S3 服务
    systemctl stop garage 2>/dev/null || true
    systemctl stop rustfs 2>/dev/null || true
    
    # 更新 Supabase 配置
    update_supabase_s3_config "external" "$S3_ENDPOINT" "$S3_REGION"
    
    log_info "已配置外部 S3"
    log_info "配置保存到: /etc/supabase/external-s3.env"
}

# 更新 Supabase S3 配置
update_supabase_s3_config() {
    local type=$1
    local endpoint=$2
    local region=$3
    
    SUPABASE_ENV=~/pigsty/app/supabase/.env
    
    if [[ -f "$SUPABASE_ENV" ]]; then
        log_info "更新 Supabase S3 配置..."
        
        sed -i "s|S3_ENDPOINT=.*|S3_ENDPOINT=${endpoint}|g" "$SUPABASE_ENV"
        sed -i "s|S3_REGION=.*|S3_REGION=${region}|g" "$SUPABASE_ENV"
        
        # 重启 storage 服务
        cd ~/pigsty/app/supabase
        if command -v docker-compose &> /dev/null; then
            docker-compose restart supabase-storage
        else
            /usr/local/bin/docker-compose restart supabase-storage
        fi
        
        log_info "Supabase Storage 服务已重启"
    else
        log_warn "未找到 Supabase 配置文件: $SUPABASE_ENV"
    fi
}

# 主函数
main() {
    if [[ $# -eq 0 ]]; then
        show_help
        exit 0
    fi
    
    case "$1" in
        runtime)
            if [[ -z "$2" ]]; then
                log_error "请指定运行时: deno 或 bun"
                exit 1
            fi
            switch_runtime "$2"
            ;;
        storage)
            if [[ -z "$2" ]]; then
                log_error "请指定存储类型: minio, garage, rustfs, external"
                exit 1
            fi
            switch_storage "$2"
            ;;
        status)
            show_status
            ;;
        -h|--help|help)
            show_help
            ;;
        *)
            log_error "未知命令: $1"
            show_help
            exit 1
            ;;
    esac
}

main "$@"

#!/bin/bash
# SupaCloud - Nginx 路由管理脚本
# 用法: router_manager.sh <add|remove|reload> <project_ref> [domain]

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"
DOMAIN="${3:-}"

# 配置路径
NGINX_SITES_DIR="${NGINX_SITES_DIR:-/etc/nginx/sites-enabled/supa-tenants}"
KONG_INTERNAL="${KONG_INTERNAL:-127.0.0.1:8000}"
BASE_DOMAIN="${BASE_DOMAIN:-localhost}"

# 验证参数
validate_params() {
    if [ -z "$ACTION" ]; then
        echo "ERROR: Missing required parameters" >&2
        echo "Usage: $0 <add|remove|reload> <project_ref> [domain]" >&2
        exit 1
    fi

    if [ "$ACTION" != "reload" ] && [ -z "$PROJECT_REF" ]; then
        echo "ERROR: project_ref is required for ${ACTION}" >&2
        exit 1
    fi
}

# 确保配置目录存在
ensure_directory() {
    mkdir -p "$NGINX_SITES_DIR"

    # 确保 nginx.conf 包含此目录
    if ! grep -q "supa-tenants" /etc/nginx/nginx.conf 2>/dev/null; then
        echo "WARNING: Make sure /etc/nginx/nginx.conf includes: include ${NGINX_SITES_DIR}/*.conf;" >&2
    fi
}

# 添加项目路由
add_route() {
    local project_domain="${DOMAIN:-${PROJECT_REF}.${BASE_DOMAIN}}"
    local api_domain="${PROJECT_REF}.api.${BASE_DOMAIN}"
    local config_file="${NGINX_SITES_DIR}/${PROJECT_REF}.conf"

    ensure_directory

    echo "Adding Nginx route for ${PROJECT_REF}..."

    cat > "$config_file" <<EOF
# SupaCloud tenant: ${PROJECT_REF}
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

server {
    listen 443 ssl;
    server_name ${api_domain};

    # ACME 自动证书
    acme_certificate ${api_domain};
    ssl_certificate     \$acme_certificate;
    ssl_certificate_key \$acme_certificate_key;

    # 安全头
    add_header X-Project-Ref ${PROJECT_REF} always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;

    location / {
        proxy_pass http://${KONG_INTERNAL};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Project-Ref ${PROJECT_REF};

        # WebSocket 支持
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
EOF

    echo "Route added for ${api_domain} -> Kong (${KONG_INTERNAL})"
}

# 移除项目路由
remove_route() {
    local config_file="${NGINX_SITES_DIR}/${PROJECT_REF}.conf"

    if [ -f "$config_file" ]; then
        rm -f "$config_file"
        echo "Route removed for ${PROJECT_REF}"
    else
        echo "No route found for ${PROJECT_REF}"
    fi
}

# 重载 Nginx 配置
reload_nginx() {
    echo "Testing Nginx configuration..."
    if nginx -t 2>/dev/null; then
        echo "Reloading Nginx..."
        nginx -s reload
        echo "Nginx reloaded successfully"
    else
        echo "ERROR: Nginx configuration test failed" >&2
        exit 1
    fi
}

# 主逻辑
validate_params

case "$ACTION" in
    add)
        add_route
        ;;
    remove)
        remove_route
        ;;
    reload)
        reload_nginx
        ;;
    *)
        echo "ERROR: Unknown action '${ACTION}'. Use: add, remove, reload" >&2
        exit 1
        ;;
esac

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

# ========== SSL 模式检测 ==========
# 检测系统中已存在的证书
detect_ssl_mode() {
    local domain="$1"
    if [ -f "/etc/pigsty/cert/${domain}.pem" ]; then
        echo "pigsty"
    elif [ -d "/etc/letsencrypt/live/${domain}" ]; then
        echo "certbot"
    else
        echo "none"
    fi
}

# 根据 SSL 模式生成对应的配置块
# $1: 域名
generate_ssl_config() {
    local domain="$1"
    local ssl_mode
    ssl_mode=$(detect_ssl_mode "$domain")

    case "$ssl_mode" in
        pigsty)
            cat <<SSL_BLOCK
    # Pigsty static certificate
    ssl_certificate     /etc/pigsty/cert/${domain}.pem;
    ssl_certificate_key /etc/pigsty/cert/${domain}.key;
SSL_BLOCK
            ;;
        certbot)
            cat <<SSL_BLOCK
    # Let's Encrypt (certbot)
    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
SSL_BLOCK
            ;;
        *)
            cat <<'SSL_BLOCK'
    # No SSL certificate found. 
    # Use ssl_manager.sh or certbot to issue certificates for this domain.
SSL_BLOCK
            ;;
    esac
}

# 添加项目路由
add_route() {
    local project_domain="${DOMAIN:-${PROJECT_REF}.${BASE_DOMAIN}}"
    local api_domain="${PROJECT_REF}.api.${BASE_DOMAIN}"
    local studio_domain="studio-${PROJECT_REF}.${BASE_DOMAIN}"
    local config_file="${NGINX_SITES_DIR}/${PROJECT_REF}.conf"

    ensure_directory

    local ssl_mode
    ssl_mode=$(detect_ssl_mode "$api_domain")
    echo "Adding Nginx route for ${PROJECT_REF}... (SSL mode: ${ssl_mode})"

    # 生成 SSL 配置
    local api_ssl_block
    api_ssl_block=$(generate_ssl_config "$api_domain")

    cat > "$config_file" <<EOF
# SupaCloud tenant: ${PROJECT_REF}
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# SSL mode: ${ssl_mode}

# --- API Endpoint ---
server {
    listen 80;
    listen 443 ssl;
    server_name ${api_domain};

${api_ssl_block}

    # 安全头
    add_header X-Project-Ref ${PROJECT_REF} always;

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

# --- Studio Endpoint ---
server {
    listen 80;
    listen 443 ssl;
    server_name ${studio_domain};

    # 安全头
    add_header X-Project-Ref ${PROJECT_REF} always;

    location / {
        # 转发到 Supabase Studio (通常在 8000 端口)
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

    echo "Route added for ${PROJECT_REF}:"
    echo "  - API:    ${api_domain}"
    echo "  - Studio: ${studio_domain}"
}

# 添加项目自定义域名 (联动 ACME / certbot)
add_custom_domain() {
    local custom_domain="${DOMAIN}"
    if [ -z "$custom_domain" ]; then
        echo "ERROR: Domain is required for add-custom-domain" >&2
        exit 1
    fi

    local config_file="${NGINX_SITES_DIR}/${PROJECT_REF}_custom_${custom_domain}.conf"
    ensure_directory

    echo "Adding custom domain ${custom_domain} for ${PROJECT_REF}..."

    # 根据证书存在情况和 Nginx 能力决定 SSL 配置
    local ssl_config
    if [ -f "/etc/pigsty/cert/${custom_domain}.pem" ]; then
        ssl_config="    ssl_certificate     /etc/pigsty/cert/${custom_domain}.pem;
    ssl_certificate_key /etc/pigsty/cert/${custom_domain}.key;"
    else
        ssl_config=$(generate_ssl_config "$custom_domain")
    fi

    cat > "$config_file" <<EOF
server {
    listen 80;
    listen 443 ssl;
    server_name ${custom_domain};

${ssl_config}

    location / {
        proxy_pass http://${KONG_INTERNAL};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Project-Ref ${PROJECT_REF};
    }
}
EOF
}

# 更新网络限制 (IP 白名单)
update_restrictions() {
    local restriction_file="${NGINX_SITES_DIR}/${PROJECT_REF}_restrictions.inc"
    local allowed_ips="${DOMAIN:-""}" # 借用 DOMAIN 参数传递逗号分隔的 IPs

    echo "# IP Restrictions for ${PROJECT_REF}" > "$restriction_file"
    if [ -n "$allowed_ips" ]; then
        IFS=',' read -ra ADDR <<< "$allowed_ips"
        for ip in "${ADDR[@]}"; do
            echo "allow $ip;" >> "$restriction_file"
        done
        echo "deny all;" >> "$restriction_file"
    else
        echo "allow all;" >> "$restriction_file"
    fi
}

# 移除项目路由
remove_route() {
    local config_file="${NGINX_SITES_DIR}/${PROJECT_REF}.conf"
    local custom_configs="${NGINX_SITES_DIR}/${PROJECT_REF}_custom_*.conf"
    local restriction_file="${NGINX_SITES_DIR}/${PROJECT_REF}_restrictions.inc"

    rm -f "$config_file" $custom_configs "$restriction_file"
    echo "Routes and restrictions removed for ${PROJECT_REF}"
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
    add-custom-domain)
        add_custom_domain
        ;;
    update-restrictions)
        update_restrictions
        ;;
    remove)
        remove_route
        ;;
    reload)
        reload_nginx
        ;;
    *)
        echo "ERROR: Unknown action '${ACTION}'. Use: add, remove, reload, add-custom-domain, update-restrictions" >&2
        exit 1
        ;;
esac

#!/bin/bash
# SupaCloud - Nginx Route Management Script
# Usage: router_manager.sh <add|remove|reload> <project_ref> [domain]

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"
DOMAIN="${3:-}"

# Configuration paths
ANGIE_SITES_DIR="${ANGIE_SITES_DIR:-/etc/angie/http.d}"
KONG_INTERNAL="${KONG_INTERNAL:-127.0.0.1:8000}"
BASE_DOMAIN="${BASE_DOMAIN:-localhost}"

# Validate parameters
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

# Ensure configuration directory exists
ensure_directory() {
    mkdir -p "$ANGIE_SITES_DIR"

    # Ensure angie.conf includes this directory
    if ! grep -q "http.d" /etc/angie/angie.conf 2>/dev/null; then
        echo "WARNING: Make sure /etc/angie/angie.conf includes: include ${ANGIE_SITES_DIR}/*.conf;" >&2
    fi
}

# ========== SSL mode detection ==========
# Detect existing certificates in the system or whether using Angie ACME
detect_ssl_mode() {
    local domain="$1"
    if [ -f "/etc/pigsty/cert/${domain}.pem" ]; then
        echo "pigsty"
    else
        # Default to Angie native ACME
        echo "angie-acme"
    fi
}

# Generate corresponding configuration block based on SSL mode
# $1: domain
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
        angie-acme)
            cat <<SSL_BLOCK
    # Angie native ACME
    acme                le;
    ssl_certificate     \$acme_cert_le;
    ssl_certificate_key \$acme_cert_key_le;
SSL_BLOCK
            ;;
        *)
            cat <<'SSL_BLOCK'
    # Fallback or No SSL
SSL_BLOCK
            ;;
    esac
}

# Add project route
add_route() {
    local project_domain="${DOMAIN:-${PROJECT_REF}.${BASE_DOMAIN}}"
    local api_domain="${PROJECT_REF}.api.${BASE_DOMAIN}"
    local studio_domain="studio-${PROJECT_REF}.${BASE_DOMAIN}"
    local config_file="${ANGIE_SITES_DIR}/${PROJECT_REF}.conf"

    ensure_directory

    local ssl_mode
    ssl_mode=$(detect_ssl_mode "$api_domain")
    echo "Adding Angie route for ${PROJECT_REF}... (SSL mode: ${ssl_mode})"

    # Generate SSL configuration
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

    # Security headers
    add_header x-project-ref ${PROJECT_REF} always;

    # Supabase Storage image rendering (cache disabled, needs pre-configured proxy_cache_path)
    location ^~ /storage/v1/render/ {
        proxy_pass http://${KONG_INTERNAL};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header x-project-ref ${PROJECT_REF};
    }

    location / {
        proxy_pass http://${KONG_INTERNAL};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Project-Ref ${PROJECT_REF};

        # WebSocket support
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

    # Use base ACME
$(generate_ssl_config "${studio_domain}")

    # Security headers
    add_header x-project-ref ${PROJECT_REF} always;

    location / {
        # Forward to Supabase Studio (usually on port 8000)
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

# Add project custom domain (with ACME integration)
add_custom_domain() {
    local custom_domain="${DOMAIN}"
    if [ -z "$custom_domain" ]; then
        echo "ERROR: Domain is required for add-custom-domain" >&2
        exit 1
    fi

    local config_file="${ANGIE_SITES_DIR}/${PROJECT_REF}_custom_${custom_domain}.conf"
    ensure_directory

    echo "Adding custom domain ${custom_domain} for ${PROJECT_REF}..."

    local ssl_config
    ssl_config=$(generate_ssl_config "$custom_domain")

    cat > "$config_file" <<EOF
server {
    listen 80;
    listen 443 ssl;
    server_name ${custom_domain};

${ssl_config}
    # Supabase Storage image rendering (cache disabled, needs pre-configured proxy_cache_path)
    location ^~ /storage/v1/render/ {
        proxy_pass http://${KONG_INTERNAL};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header x-project-ref ${PROJECT_REF};
    }

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

# Update network restrictions (IP whitelist)
update_restrictions() {
    local restriction_file="${ANGIE_SITES_DIR}/${PROJECT_REF}_restrictions.inc"
    local allowed_ips="${DOMAIN:-""}" # Borrow DOMAIN parameter to pass comma-separated IPs

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

# Remove project route
remove_route() {
    local config_file="${ANGIE_SITES_DIR}/${PROJECT_REF}.conf"
    local custom_configs="${ANGIE_SITES_DIR}/${PROJECT_REF}_custom_*.conf"
    local restriction_file="${ANGIE_SITES_DIR}/${PROJECT_REF}_restrictions.inc"

    rm -f "$config_file" $custom_configs "$restriction_file"
    echo "Routes and restrictions removed for ${PROJECT_REF}"
}

# Reload Angie configuration
reload_angie() {
    echo "Testing Angie configuration..."
    if angie -t 2>/dev/null; then
        echo "Reloading Angie..."
        angie -s reload
        echo "Angie reloaded successfully"
    else
        echo "ERROR: Angie configuration test failed" >&2
        exit 1
    fi
}

# Main logic
validate_params

case "$ACTION" in
    add)
        add_route
        reload_angie
        ;;
    add-custom-domain)
        add_custom_domain
        reload_angie
        ;;
    update-restrictions)
        update_restrictions
        reload_angie
        ;;
    remove)
        remove_route
        reload_angie
        ;;
    reload)
        reload_angie
        ;;
    *)
        echo "ERROR: Unknown action '${ACTION}'. Use: add, remove, reload, add-custom-domain, update-restrictions" >&2
        exit 1
        ;;
esac

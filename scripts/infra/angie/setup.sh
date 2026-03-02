#!/bin/bash
# Angie installation script - alternative to Nginx as API gateway
# Compatible with APT (Debian/Ubuntu) and DNF/YUM (RHEL/Rocky/CentOS) systems

set -euo pipefail

ANGIE_VERSION="${ANGIE_VERSION:-1.8.0}"

log_info() { echo "[INFO] $*"; }
log_warn() { echo "[WARN] $*" >&2; }
log_error() { echo "[ERROR] $*" >&2; }

# Detect OS and its package manager
if command -v apt-get &>/dev/null; then
    PKG_MANAGER="apt"
elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
elif command -v yum &>/dev/null; then
    PKG_MANAGER="yum"
else
    log_error "Unsupported OS: Neither apt, dnf nor yum detected"
    exit 1
fi

# Check if already installed
if command -v angie &>/dev/null; then
    log_info "Angie is already installed: $(angie -v 2>&1)"
    exit 0
fi

log_info "Starting Angie ${ANGIE_VERSION} installation (using ${PKG_MANAGER})..."

if [ "$PKG_MANAGER" = "apt" ]; then
    # === Installation logic for Debian / Ubuntu ===
    log_info "Detected Debian/Ubuntu system, configuring APT repository..."

    # 1. Install base utilities
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg lsb-release

    # 2. Import Angie official GPG key
    if [ ! -f /etc/apt/keyrings/angie.gpg ]; then
        mkdir -p /etc/apt/keyrings
        curl -fsSL https://angie.software/keys/angie-signing.rsa.pub | \
            gpg --dearmor -o /etc/apt/keyrings/angie.gpg
    fi

    # 3. Add APT source list
    OS_ID=$(lsb_release -is | tr '[:upper:]' '[:lower:]')
    OS_CODENAME=$(lsb_release -cs)
    
    echo "deb [signed-by=/etc/apt/keyrings/angie.gpg] https://download.angie.software/angie/${OS_ID}/ ${OS_CODENAME} main" \
        > /etc/apt/sources.list.d/angie.list
    
    # 4. Update and install Angie with common modules
    apt-get update -y
    apt-get install -y angie angie-module-brotli angie-module-headers-more || {
        log_error "apt installation failed"
        exit 1
    }

elif [ "$PKG_MANAGER" = "dnf" ] || [ "$PKG_MANAGER" = "yum" ]; then
    # === Installation logic for RHEL / Rocky / CentOS ===
    log_info "Detected RHEL/CentOS/Rocky system, configuring DNF/YUM repository..."

    if [[ ! -f /etc/yum.repos.d/angie.repo ]]; then
        cat > /etc/yum.repos.d/angie.repo << 'EOF'
[angie]
name=Angie repo
baseurl=https://download.angie.software/angie/centos/$releasever/
enabled=1
gpgcheck=1
gpgkey=https://download.angie.software/angie/centos/RPM-GPG-KEY-angie
EOF
    fi

    # Install Angie
    $PKG_MANAGER install -y angie angie-module-headers-more angie-module-brotli || {
        log_error "$PKG_MANAGER installation failed, attempting direct RPM download..."
        
        # Fallback: Direct RPM download (example for EL 9)
        local rpm_url="https://download.angie.software/angie/centos/9/x86_64/"
        $PKG_MANAGER install -y "${rpm_url}angie-${ANGIE_VERSION}-1.el9.x86_64.rpm" 2>/dev/null || {
            log_warn "RPM download failed, please check network or system version support"
            exit 1
        }
    }
fi

# Create necessary directories
mkdir -p /etc/angie/http.d
mkdir -p /etc/angie/stream.d
mkdir -p /var/log/angie
mkdir -p /var/cache/angie

# Create angie user if not exists
id angie &>/dev/null || useradd -r -s /sbin/nologin angie

# Set permissions
chown -R angie:angie /var/log/angie /var/cache/angie
chown -R angie:angie /etc/angie 2>/dev/null || true

# Stop and disable legacy Nginx service to avoid port 80/443 conflict
if systemctl list-unit-files nginx.service &>/dev/null 2>&1; then
    systemctl stop nginx 2>/dev/null || true
    systemctl disable nginx 2>/dev/null || true
fi

# Create systemd unit file
if [[ ! -f /etc/systemd/system/angie.service ]]; then
    cat > /etc/systemd/system/angie.service << 'EOF'
[Unit]
Description=Angie - high performance web server
Documentation=https://angie.software/en/
After=network-online.target remote-fs.target nss-lookup.target
Wants=network-online.target

[Service]
Type=forking
PIDFile=/var/run/angie.pid
ExecStartPre=/usr/sbin/angie -t
ExecStart=/usr/sbin/angie
ExecReload=/bin/kill -s HUP $MAINPID
ExecStop=/bin/kill -s QUIT $MAINPID
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
fi

# Create base configuration
if [[ ! -f /etc/angie/angie.conf ]]; then
    cat > /etc/angie/angie.conf << 'EOF'
user angie;
worker_processes auto;
error_log /var/log/angie/error.log notice;
pid /var/run/angie.pid;

# Explicitly load modules (if they exist)
load_module modules/ngx_http_headers_more_filter_module.so;
load_module modules/ngx_http_brotli_filter_module.so;
load_module modules/ngx_http_brotli_static_module.so;

events {
    worker_connections 10240;
}

http {
    include       /etc/angie/mime.types;
    default_type  application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    access_log /var/log/angie/access.log main;

    sendfile        on;
    tcp_nopush      on;
    tcp_nodelay     on;
    keepalive_timeout 65;
    types_hash_max_size 2048;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/rss+xml application/atom+xml image/svg+xml;

    include /etc/angie/http.d/*.conf;
}
EOF
fi

# Ensure mime.types existence to avoid startup errors
if [ ! -f /etc/angie/mime.types ]; then
    log_warn "mime.types not found, generating default version"
    cat > /etc/angie/mime.types << 'EOF'
types {
    text/html                             html htm shtml;
    text/css                              css;
    text/xml                              xml;
    image/gif                             gif;
    image/jpeg                            jpeg jpg;
    application/javascript                js;
    application/atom+xml                  atom;
    application/rss+xml                   rss;
    font/woff                             woff;
    font/woff2                            woff2;
    text/mathml                           mml;
    text/plain                            txt;
    image/png                             png;
    image/svg+xml                         svg svgz;
    application/json                      json;
}
EOF
fi

# Enable and start Angie
systemctl enable angie
systemctl start angie || {
    log_error "Failed to start Angie"
    journalctl -u angie --no-pager -n 20
    angie -t || true
    exit 1
}

log_info "Angie installation complete: $(angie -v 2>&1)"
log_info "Config directory: /etc/angie/"
log_info "Site configs: /etc/angie/http.d/"

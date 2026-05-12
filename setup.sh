#!/bin/bash
# ============================================================
# SupaCloud Simple Installation Entry Script
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh | sudo bash
# ============================================================

set -e

export DEBIAN_FRONTEND=noninteractive
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

derive_base_domain() {
    local domain="${1:-}"
    domain="${domain#api.}"
    domain="${domain#studio.}"
    printf '%s' "$domain"
}

derive_studio_domain() {
    local api_domain="${1:-}"
    local internal_ip="${2:-}"
    if [[ -z "$api_domain" ]]; then
        printf 'studio.%s.nip.io' "$internal_ip"
        return
    fi
    printf 'studio.%s' "$(derive_base_domain "$api_domain")"
}

# Check root privileges
if [[ $EUID -ne 0 ]]; then
    log_error "Please run this script as root"
    exit 1
fi

# Check and install base dependencies
install_base_deps() {
    log_step "Checking base dependencies..."
    if command -v git &>/dev/null && command -v curl &>/dev/null && command -v unzip &>/dev/null; then
        log_info "Base dependencies ready"
        return
    fi

    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        case "$ID" in
            rocky|almalinux|centos|rhel)
                yum install -y git curl unzip
                ;;
            ubuntu|debian)
                apt-get update && apt-get install -y git curl unzip
                ;;
            *)
                log_warn "Unrecognized system, please ensure git and curl are installed"
                ;;
        esac
    fi
}

# Clone repository
clone_repo() {
    INSTALL_DIR="/opt/supacloud"
    if [[ -d "$INSTALL_DIR" ]]; then
        log_info "Target directory $INSTALL_DIR already exists, updating code..."
        cd "$INSTALL_DIR"
        git pull || log_warn "Code update failed, will use existing version"
    else
        log_step "Cloning SupaCloud repository to $INSTALL_DIR..."
        git clone --depth 1 https://ghproxy.net/https://github.com/zuohuadong/supacloud.git "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi
}

# Download core binaries
download_binaries() {
    log_step "Detecting CPU architecture and downloading core binaries..."
    local ARCH=$(uname -m)
    local BIN_NAME=""
    local EDGE_RT_BIN_NAME=""
    
    if [[ "$ARCH" == "x86_64" ]]; then
        BIN_NAME="supacloud-linux-amd64"
        EDGE_RT_BIN_NAME="supacloud-edge-runtime-linux-amd64"
    elif [[ "$ARCH" == "aarch64" ]]; then
        BIN_NAME="supacloud-linux-arm64"
        EDGE_RT_BIN_NAME="supacloud-edge-runtime-linux-arm64"
    else
        log_error "Unsupported CPU architecture: $ARCH"
        exit 1
    fi

    # Prefer detecting if local binary exists (e.g., locally built)
    if [[ -f "./$BIN_NAME" ]] || [[ -f "./dist/$BIN_NAME" ]]; then
        log_info "Local management API binary artifact found, skipping download"
    else
        log_info "Downloading latest management API binary from GitHub ($BIN_NAME)..."
        local DOWNLOAD_URL="https://ghproxy.net/https://github.com/zuohuadong/supacloud/releases/latest/download/${BIN_NAME}"
        mkdir -p dist
        curl -Lo "dist/${BIN_NAME}" "$DOWNLOAD_URL" || {
            log_warn "Download from Release failed (may not be published yet), please ensure local binary has been generated via bun run build"
        }
    fi

    # Download edge-runtime binary
    if [[ -f "./$EDGE_RT_BIN_NAME" ]] || [[ -f "./dist/$EDGE_RT_BIN_NAME" ]] || [[ -f "./packages/edge-runtime/dist/$EDGE_RT_BIN_NAME" ]]; then
        log_info "Local edge-runtime binary artifact found, skipping download"
    else
        log_info "Downloading latest edge-runtime binary from GitHub ($EDGE_RT_BIN_NAME)..."
        local EDGE_RT_DOWNLOAD_URL="https://ghproxy.net/https://github.com/zuohuadong/supacloud/releases/latest/download/${EDGE_RT_BIN_NAME}"
        mkdir -p dist
        curl -Lo "dist/${EDGE_RT_BIN_NAME}" "$EDGE_RT_DOWNLOAD_URL" || {
            log_warn "Edge-runtime binary download failed, will fall back to source mode"
        }
    fi

    # Download web-console static build
    if [[ -f "./dist/web-console-build.tar.gz" ]] || [[ -f "./packages/web-console/build/index.html" ]]; then
        log_info "Local Web Console build found, skipping download"
    else
        log_info "Downloading Web Console (Studio UI) from GitHub Releases..."
        local WC_DOWNLOAD_URL="https://ghproxy.net/https://github.com/zuohuadong/supacloud/releases/latest/download/web-console-build.tar.gz"
        mkdir -p dist
        curl -Lo "dist/web-console-build.tar.gz" "$WC_DOWNLOAD_URL" || {
            log_warn "Web Console download failed, Studio UI may not be available"
        }
    fi
}

# ⚠️ OpenCloudOS compatibility pre-check
# Note: No longer locking OpenSSL, as it would block necessary package installations
# Instead, handle repo compatibility issues in install.sh
check_openssl_compat() {
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        case "$ID" in
            opencloudos|tencentos)
                log_warn "Detected $PRETTY_NAME"
                log_warn "Will use compatibility mode for installation, avoiding Pigsty using Rocky Linux repo"
                export USE_OPENCLOUDOS_COMPAT=true
                ;;
        esac
    fi
}

# Generate configuration
# Generate configuration
generate_config() {
    log_step "Preparing installation configuration..."
    
    CONFIG_FILE="config.env"
    if [[ -f "$CONFIG_FILE" ]]; then
        log_info "Configuration file already exists, will use existing configuration"
        return
    fi

    # Auto-get internal IP
    if [[ -z "$INTERNAL_IP" ]]; then
        INTERNAL_IP=$(hostname -I | awk '{print $1}')
    fi
    
    # Domain logic: environment variable > interactive input > auto-generate (nip.io)
    if [[ -z "$SUPABASE_PUBLIC_DOMAIN" ]]; then
        if [ -t 0 ]; then
            echo -e "${YELLOW}Please enter your Supabase API domain (press Enter to use api.${INTERNAL_IP}.nip.io)${NC}"
            read -r -p "Domain: " SUPABASE_PUBLIC_DOMAIN
        fi
        
        if [[ -z "$SUPABASE_PUBLIC_DOMAIN" ]]; then
            SUPABASE_PUBLIC_DOMAIN="api.${INTERNAL_IP}.nip.io"
            log_info "Using auto-assigned domain: $SUPABASE_PUBLIC_DOMAIN"
        fi
    fi

    # Auto-generate strong passwords (if not provided via environment variable)
    [[ -z "$POSTGRES_PASSWORD" ]] && POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)
    [[ -z "$DASHBOARD_PASSWORD" ]] && DASHBOARD_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)
    [[ -z "$GRAFANA_PASSWORD" ]] && GRAFANA_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)

    # Write configuration
    cat > "$CONFIG_FILE" << EOF
#!/bin/bash
# SupaCloud Auto-generated Configuration File

INTERNAL_IP="${INTERNAL_IP}"
SUPABASE_PUBLIC_DOMAIN="${SUPABASE_PUBLIC_DOMAIN}"
SUPABASE_STUDIO_DOMAIN="${SUPABASE_STUDIO_DOMAIN:-$(derive_studio_domain "$SUPABASE_PUBLIC_DOMAIN" "$INTERNAL_IP")}"

DASHBOARD_USERNAME="${DASHBOARD_USERNAME:-admin}"
DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD}"
GRAFANA_PASSWORD="${GRAFANA_PASSWORD}"

SWAP_SIZE_GB="${SWAP_SIZE_GB:-4}"
PG_VERSION="${PG_VERSION:-18}"
S3_STORAGE_TYPE="${S3_STORAGE_TYPE:-juicefs}"
EDGE_RUNTIME="${EDGE_RUNTIME:-bun}"
ENABLE_ANALYTICS="${ENABLE_ANALYTICS:-true}"
ANALYTICS_BACKEND="${ANALYTICS_BACKEND:-postgres}"
EOF

    log_info "Configuration ready: $CONFIG_FILE"
    echo -e "----------------------------------------"
    echo -e "API Domain:      ${SUPABASE_PUBLIC_DOMAIN}"
    echo -e "Studio Password: ${DASHBOARD_PASSWORD}"
    echo -e "Database Password: ${POSTGRES_PASSWORD}"
    echo -e "----------------------------------------"
    log_warn "Please record the above passwords. Installation starting immediately..."
}


# Run installation
run_install() {
    log_step "Starting formal installation program..."
    bash install.sh
}

# Main program
main() {
    echo -e "${GREEN}"
    echo "============================================================"
    echo "       SupaCloud - Next-Gen Enterprise Supabase Self-Hosting"
    echo "============================================================"
    echo -e "${NC}"

    install_base_deps
    clone_repo
    download_binaries
    check_openssl_compat
    generate_config
    run_install
}

main "$@"

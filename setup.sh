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

require_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "Please run this script as root"
        return 1
    fi
}

# Check and install base dependencies
install_base_deps() {
    log_step "Checking base dependencies..."
    if command -v git &>/dev/null \
        && command -v curl &>/dev/null \
        && command -v unzip &>/dev/null \
        && command -v jq &>/dev/null \
        && command -v file &>/dev/null \
        && command -v python3 &>/dev/null \
        && command -v sha256sum &>/dev/null \
        && command -v tar &>/dev/null \
        && command -v gzip &>/dev/null \
        && command -v openssl &>/dev/null; then
        log_info "Base dependencies ready"
        return
    fi

    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        case "$ID" in
            rocky|almalinux|centos|rhel)
                yum install -y git curl unzip jq file coreutils python3 tar gzip openssl
                ;;
            ubuntu|debian)
                apt-get update && apt-get install -y git curl unzip jq file coreutils python3 tar gzip openssl
                ;;
            *)
                log_warn "Unrecognized system, please ensure git and curl are installed"
                ;;
        esac
    fi
}

normalize_repository_url() {
    local value="${1%/}"
    value="${value%.git}"
    printf '%s' "$value"
}

repository_origin_allowed() {
    local actual="$1"
    local official="$2"
    actual=$(normalize_repository_url "$actual")
    official=$(normalize_repository_url "$official")
    [[ "$actual" == "$official" ]]
}

verify_setup_checkout() {
    local install_dir="$1"
    local official_origin="$2"
    local expected_branch="$3"
    local require_installer_files="${4:-true}"
    local origin current_branch tracked_status helper

    if ! git -C "$install_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        log_error "Existing install directory is not a Git checkout: $install_dir"
        return 1
    fi
    tracked_status=$(git -C "$install_dir" status --porcelain --untracked-files=no) || return 1
    if [[ -n "$tracked_status" ]]; then
        log_error "Existing SupaCloud checkout has tracked changes; refusing to update or source it"
        return 1
    fi
    origin=$(git -C "$install_dir" remote get-url origin 2>/dev/null) || {
        log_error "Existing SupaCloud checkout has no readable origin"
        return 1
    }
    if ! repository_origin_allowed "$origin" "$official_origin"; then
        log_error "Existing SupaCloud checkout origin is not trusted: $origin"
        return 1
    fi
    current_branch=$(git -C "$install_dir" symbolic-ref --quiet --short HEAD 2>/dev/null) || {
        log_error "Existing SupaCloud checkout is detached; expected branch $expected_branch"
        return 1
    }
    if [[ "$current_branch" != "$expected_branch" ]]; then
        log_error "Existing SupaCloud checkout is on $current_branch; expected $expected_branch"
        return 1
    fi
    if [[ "$require_installer_files" == "true" ]]; then
        for helper in scripts/lib/install_config.sh scripts/lib/release_assets.sh install.sh; do
            if ! git -C "$install_dir" ls-files --error-unmatch "$helper" >/dev/null 2>&1 \
                || [[ ! -f "$install_dir/$helper" ]]; then
                log_error "Trusted checkout is missing tracked installer file: $helper"
                return 1
            fi
        done
    fi
}

# Clone or fast-forward only a trusted checkout. A failed update must never
# fall through to sourcing stale installer helpers with root privileges.
clone_repo() {
    INSTALL_DIR="${SUPACLOUD_INSTALL_DIR:-/opt/supacloud}"
    local official_origin="https://github.com/zuohuadong/supacloud.git"
    local expected_branch="${SUPACLOUD_SETUP_BRANCH:-main}"

    if [[ -e "$INSTALL_DIR" ]]; then
        verify_setup_checkout "$INSTALL_DIR" "$official_origin" "$expected_branch" false || return 1
        log_info "Trusted checkout found at $INSTALL_DIR; fast-forwarding $expected_branch..."
        if ! git -C "$INSTALL_DIR" pull --ff-only origin "$expected_branch"; then
            log_error "Fast-forward update from the official GitHub HTTPS origin failed; refusing to execute proxied or stale source"
            return 1
        fi
        verify_setup_checkout "$INSTALL_DIR" "$official_origin" "$expected_branch" true || return 1
    else
        log_step "Cloning trusted SupaCloud repository to $INSTALL_DIR..."
        git clone --depth 1 --branch "$expected_branch" "$official_origin" "$INSTALL_DIR" || {
            log_error "Clone from the official GitHub HTTPS origin failed; SUPACLOUD_GITHUB_PROXY is only used for verified Release assets"
            return 1
        }
        verify_setup_checkout "$INSTALL_DIR" "$official_origin" "$expected_branch" true || return 1
    fi
    cd "$INSTALL_DIR"
}

consume_setup_install_input() {
    local setup_input="${SUPACLOUD_SETUP_INPUT_FILE:-}"
    [[ -n "$setup_input" ]] || return 0
    if [[ ! "$setup_input" =~ ^/etc/supabase/\.install-input-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.env$ ]]; then
        log_error "SUPACLOUD_SETUP_INPUT_FILE must be a unique protected /etc/supabase/.install-input-<uuid>.env file"
        return 1
    fi
    CONFIG_FILE="${SUPACLOUD_INSTALL_CONFIG_FILE:-/etc/supabase/install.env}"
    if ! supacloud_consume_protected_install_input "$setup_input" "$CONFIG_FILE"; then
        rm -f "$setup_input"
        log_error "Protected setup input validation or merge failed"
        return 1
    fi
    unset SUPACLOUD_SETUP_INPUT_FILE
    log_info "Protected Admin installation input merged into $CONFIG_FILE"
}

ensure_release_attestation_verifier() {
    if supacloud_attestation_verifier_available; then
        log_info "GitHub artifact attestation verifier is ready"
        return 0
    fi
    if [[ "${SUPACLOUD_ALLOW_UNVERIFIED_RELEASE:-false}" == "true" ]]; then
        log_warn "Release attestation verification is disabled by explicit emergency break-glass"
        return 0
    fi

    log_info "Installing the pinned GitHub CLI verifier (${SUPACLOUD_GH_VERSION})..."
    supacloud_install_pinned_gh /usr/local/bin/gh || {
        log_error "Unable to install the pinned GitHub CLI verifier"
        return 1
    }
    export PATH="/usr/local/bin:${PATH}"
    hash -r

    if ! supacloud_attestation_verifier_available; then
        log_error "GitHub CLI with 'gh attestation verify' is required for network Release artifacts. Install it, or explicitly set SUPACLOUD_ALLOW_UNVERIFIED_RELEASE=true only for emergency break-glass use."
        return 1
    fi
}

# Download core binaries
download_binaries() {
    log_step "Detecting CPU architecture and downloading core binaries..."
    local ARCH=$(uname -m)
    local BIN_NAME=""
    local EDGE_RT_BIN_NAME=""
    local PGREDIS_RT_BIN_NAME=""
    local CADDY_BIN_NAME=""
    local artifact_mode="${SUPACLOUD_SETUP_ARTIFACT_MODE:-release}"
    
    if [[ "$ARCH" == "x86_64" ]]; then
        BIN_NAME="supacloud-linux-amd64"
        EDGE_RT_BIN_NAME="supacloud-edge-runtime-linux-amd64"
        PGREDIS_RT_BIN_NAME="supacloud-pgredis-runtime-linux-amd64"
        CADDY_BIN_NAME="supacloud-caddy-linux-amd64"
    elif [[ "$ARCH" == "aarch64" ]]; then
        BIN_NAME="supacloud-linux-arm64"
        EDGE_RT_BIN_NAME="supacloud-edge-runtime-linux-arm64"
        PGREDIS_RT_BIN_NAME="supacloud-pgredis-runtime-linux-arm64"
        CADDY_BIN_NAME="supacloud-caddy-linux-arm64"
    else
        log_error "Unsupported CPU architecture: $ARCH"
        exit 1
    fi

    mkdir -p dist

    case "$artifact_mode" in
        release)
            # A network bootstrap re-resolves and verifies every component on
            # every run. Existing dist files or source builds never bypass
            # same-release SHA256 and GitHub attestation verification.
            log_info "Resolving the verified Management API component release..."
            local management_release
            management_release=$(supacloud_fetch_component_release management-api \
                "${SUPACLOUD_MANAGEMENT_VERSION:-latest}" \
                "$BIN_NAME" web-console-build.tar.gz "$CADDY_BIN_NAME") || {
                log_error "No verified Management API release contains all required artifacts"
                return 1
            }
            supacloud_download_release_asset "$management_release" "$BIN_NAME" "dist/${BIN_NAME}" binary || return 1
            supacloud_download_release_asset "$management_release" web-console-build.tar.gz "dist/web-console-build.tar.gz" tar || return 1
            supacloud_download_release_asset "$management_release" "$CADDY_BIN_NAME" "dist/${CADDY_BIN_NAME}" binary || return 1

            log_info "Resolving the verified Edge Runtime component release..."
            local edge_release
            edge_release=$(supacloud_fetch_component_release edge-runtime \
                "${SUPACLOUD_EDGE_RUNTIME_VERSION:-latest}" "$EDGE_RT_BIN_NAME") || {
                log_error "No verified Edge Runtime release contains $EDGE_RT_BIN_NAME"
                return 1
            }
            supacloud_download_release_asset "$edge_release" "$EDGE_RT_BIN_NAME" "dist/${EDGE_RT_BIN_NAME}" binary || return 1

            log_info "Resolving the verified pgredis-runtime component release..."
            local pgredis_release
            pgredis_release=$(supacloud_fetch_component_release pgredis-runtime \
                "${SUPACLOUD_PGREDIS_RUNTIME_VERSION:-latest}" "$PGREDIS_RT_BIN_NAME") || {
                log_error "No verified pgredis-runtime release contains $PGREDIS_RT_BIN_NAME"
                return 1
            }
            supacloud_download_release_asset "$pgredis_release" "$PGREDIS_RT_BIN_NAME" "dist/${PGREDIS_RT_BIN_NAME}" binary || return 1
            ;;
        local)
            log_warn "Explicit local artifact mode enabled; network Release attestations are not used"
            local management_source="" edge_source="" pgredis_source="" caddy_source=""
            for management_source in "dist/${BIN_NAME}" "./${BIN_NAME}"; do
                [[ -f "$management_source" ]] && break
                management_source=""
            done
            for edge_source in "dist/${EDGE_RT_BIN_NAME}" \
                "packages/edge-runtime/dist/${EDGE_RT_BIN_NAME}" "./${EDGE_RT_BIN_NAME}"; do
                [[ -f "$edge_source" ]] && break
                edge_source=""
            done
            for pgredis_source in "dist/${PGREDIS_RT_BIN_NAME}" \
                "packages/pgredis-runtime/dist/${PGREDIS_RT_BIN_NAME}" "./${PGREDIS_RT_BIN_NAME}"; do
                [[ -f "$pgredis_source" ]] && break
                pgredis_source=""
            done
            for caddy_source in "dist/${CADDY_BIN_NAME}" "./${CADDY_BIN_NAME}"; do
                [[ -f "$caddy_source" ]] && break
                caddy_source=""
            done
            [[ -n "$management_source" ]] && supacloud_validate_binary "$management_source" "$BIN_NAME" || return 1
            [[ -n "$edge_source" ]] && supacloud_validate_binary "$edge_source" "$EDGE_RT_BIN_NAME" || return 1
            if [[ -n "$pgredis_source" ]]; then
                supacloud_validate_binary "$pgredis_source" "$PGREDIS_RT_BIN_NAME" || return 1
            elif [[ ! -f packages/pgredis-runtime/server.ts ]]; then
                log_error "Local artifact mode requires a pgredis-runtime binary or source package"
                return 1
            fi
            [[ -n "$caddy_source" ]] && supacloud_validate_binary "$caddy_source" "$CADDY_BIN_NAME" || return 1
            if [[ -f dist/web-console-build.tar.gz ]]; then
                supacloud_validate_tar dist/web-console-build.tar.gz || return 1
            elif [[ ! -f packages/web-console/build/index.html ]]; then
                log_error "Local artifact mode requires a validated Web Console tarball or local build"
                return 1
            fi
            [[ "$management_source" == "dist/${BIN_NAME}" ]] || cp "$management_source" "dist/${BIN_NAME}"
            [[ "$edge_source" == "dist/${EDGE_RT_BIN_NAME}" ]] || cp "$edge_source" "dist/${EDGE_RT_BIN_NAME}"
            if [[ -n "$pgredis_source" && "$pgredis_source" != "dist/${PGREDIS_RT_BIN_NAME}" ]]; then
                cp "$pgredis_source" "dist/${PGREDIS_RT_BIN_NAME}"
            fi
            [[ "$caddy_source" == "dist/${CADDY_BIN_NAME}" ]] || cp "$caddy_source" "dist/${CADDY_BIN_NAME}"
            ;;
        *)
            log_error "Unknown SUPACLOUD_SETUP_ARTIFACT_MODE: $artifact_mode (expected release or local)"
            return 1
            ;;
    esac
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
generate_config() {
    log_step "Preparing installation configuration..."
    
    CONFIG_FILE="${SUPACLOUD_INSTALL_CONFIG_FILE:-/etc/supabase/install.env}"
    mkdir -p "$(dirname "$CONFIG_FILE")"
    if [[ -f "$CONFIG_FILE" ]]; then
        chmod 600 "$CONFIG_FILE"
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

    SUPABASE_STUDIO_DOMAIN="${SUPABASE_STUDIO_DOMAIN:-$(derive_studio_domain "$SUPABASE_PUBLIC_DOMAIN" "$INTERNAL_IP")}"

    # 使用 Bash %q 序列化所有值，避免引号、命令替换或换行被配置文件重新解释。
    supacloud_write_install_input_config "$CONFIG_FILE"

    log_info "Configuration ready: $CONFIG_FILE"
    log_warn "Generated credentials are stored in the root-only configuration file and will not be printed."
}


# Run installation
run_install() {
    log_step "Starting formal installation program..."
    if [[ "${SUPACLOUD_SETUP_ARTIFACT_MODE:-release}" == "release" ]]; then
        SUPACLOUD_SETUP_ARTIFACT_MODE=release \
            SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS=true \
            SUPACLOUD_INSTALL_CONFIG_FILE="$CONFIG_FILE" bash install.sh
    else
        SUPACLOUD_SETUP_ARTIFACT_MODE=local \
            SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS=false \
            SUPACLOUD_INSTALL_CONFIG_FILE="$CONFIG_FILE" bash install.sh
    fi
}

# Main program
main() {
    require_root
    echo -e "${GREEN}"
    echo "============================================================"
    echo "       SupaCloud - Next-Gen Enterprise Supabase Self-Hosting"
    echo "============================================================"
    echo -e "${NC}"

    install_base_deps
    clone_repo
    SCRIPT_DIR="$INSTALL_DIR"
    # shellcheck source=scripts/lib/install_config.sh
    source "${SCRIPT_DIR}/scripts/lib/install_config.sh"
    # shellcheck source=scripts/lib/release_assets.sh
    source "${SCRIPT_DIR}/scripts/lib/release_assets.sh"
    consume_setup_install_input || return 1
    case "${SUPACLOUD_SETUP_ARTIFACT_MODE:-release}" in
        release) ensure_release_attestation_verifier ;;
        local) log_warn "Using explicitly selected local artifact mode" ;;
        *) log_error "SUPACLOUD_SETUP_ARTIFACT_MODE must be release or local"; return 1 ;;
    esac
    download_binaries
    check_openssl_compat
    generate_config
    run_install
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi

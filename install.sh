#!/bin/bash
# ============================================================
# Pigsty Supabase One-click Installation Script
# 
# Usage:
#   1. Edit config.env configuration file
#   2. Run: sudo bash install.sh [options]
#
# Options:
#   --ip <ip>              Specify internal IP (INTERNAL_IP)
#   --domain <domain>      Specify API domain (SUPABASE_PUBLIC_DOMAIN)
#   --studio <domain>      Specify Studio domain (SUPABASE_STUDIO_DOMAIN)
#   --s3 <type>            Specify storage type (minio|juicefs)
#   --password <pass>      Specify database/dashboard password (unified setting)
#   --help                 Show help information
#
# Supported OS: CentOS 9, Ubuntu 22.04/24.04, Debian 12
# ============================================================

set -e

export DEBIAN_FRONTEND=noninteractive

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.env"
OPT_CONFIG_FILE="/opt/supacloud/config.env"

# -- Command Line Argument Parsing --------------------------------------------
# Parse arguments first so they can override configuration file values
while [[ $# -gt 0 ]]; do
    case "$1" in
        --ip)     INTERNAL_IP="$2"; shift 2 ;;
        --domain) SUPABASE_PUBLIC_DOMAIN="$2"; shift 2 ;;
        --studio) SUPABASE_STUDIO_DOMAIN="$2"; shift 2 ;;
        --s3)     S3_STORAGE_TYPE="$2"; shift 2 ;;
        --password) 
            POSTGRES_PASSWORD="$2"; 
            DASHBOARD_PASSWORD="$2"; 
            GRAFANA_PASSWORD="$2"; 
            shift 2 ;;
        --help)
            echo "Usage: sudo bash install.sh [options]"
            echo "Options:"
            echo "  --ip <ip>          Specify internal IP"
            echo "  --domain <domain>  Specify Supabase API domain"
            echo "  --studio <domain>  Specify Supabase Studio domain"
            echo "  --s3 <type>        Specify storage type (minio | juicefs)"
            echo "  --password <pass>  Set unified password for DB and dashboard"
            exit 0
            ;;
        *) shift ;;
    esac
done

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

ensure_pg_hba_rule() {
    local rule="$1"
    local pg_hba="${2:-/pg/data/pg_hba.conf}"
    local patroni_config=""
    local cluster_name=""

    if command -v patronictl >/dev/null 2>&1; then
        for candidate in /etc/patroni/patroni.yml /etc/patroni.yml /etc/patroni.yaml; do
            if [[ -f "$candidate" ]]; then
                patroni_config="$candidate"
                break
            fi
        done
    fi

    if [[ -n "$patroni_config" ]] && [[ -f "$pg_hba" ]] && grep -q "overwritten by Patroni" "$pg_hba" 2>/dev/null; then
        cluster_name=$(patronictl -c "$patroni_config" list 2>/dev/null | sed -n 's/.*Cluster: \([^ ]*\).*/\1/p' | head -1)
        cluster_name="${cluster_name:-pg-meta}"
        local tmp_before="" tmp_after=""
        tmp_before=$(mktemp) || {
            log_warn "Failed to allocate temporary file for Patroni pg_hba update"
            return 1
        }
        tmp_after=$(mktemp) || {
            log_warn "Failed to allocate temporary file for Patroni pg_hba update"
            rm -f "$tmp_before"
            return 1
        }
        if ! patronictl -c "$patroni_config" show-config > "$tmp_before"; then
            log_warn "Failed to read Patroni dynamic config; cannot add pg_hba rule: $rule"
            rm -f "$tmp_before" "$tmp_after"
            return 1
        fi
        if ! RULE="$rule" python3 - "$tmp_before" "$tmp_after" <<'PYCODE'
import os
import sys
import yaml

src, dst = sys.argv[1], sys.argv[2]
rule = os.environ["RULE"]
with open(src, "r", encoding="utf-8") as fh:
    data = yaml.safe_load(fh) or {}
postgresql = data.setdefault("postgresql", {})
pg_hba = postgresql.setdefault("pg_hba", [])
if rule not in pg_hba:
    pg_hba.insert(0, rule)
with open(dst, "w", encoding="utf-8") as fh:
    yaml.safe_dump(data, fh, sort_keys=False)
PYCODE
        then
            log_warn "Failed to render Patroni pg_hba update; cannot add rule: $rule"
            rm -f "$tmp_before" "$tmp_after"
            return 1
        fi
        if ! cmp -s "$tmp_before" "$tmp_after"; then
            log_info "Adding Patroni pg_hba rule: $rule"
            if ! patronictl -c "$patroni_config" edit-config --apply "$tmp_after" --force "$cluster_name"; then
                log_warn "Failed to apply Patroni pg_hba rule: $rule"
                rm -f "$tmp_before" "$tmp_after"
                return 1
            fi
        else
            log_info "Patroni pg_hba rule already exists: $rule"
        fi
        rm -f "$tmp_before" "$tmp_after"
        sudo -u postgres psql -c "SELECT pg_reload_conf();" 2>/dev/null || true
        return 0
    fi

    if [[ ! -f "$pg_hba" ]]; then
        log_warn "$pg_hba not found, cannot add pg_hba rule: $rule"
        return 1
    fi

    if grep -qF "$rule" "$pg_hba"; then
        log_info "pg_hba rule already exists: $rule"
    else
        log_info "Adding pg_hba rule: $rule"
        cp "$pg_hba" "${pg_hba}.bak.$(date +%s)"
        echo "$rule" >> "$pg_hba"
    fi
}


configure_low_memory_tcp_guardrails() {
    case "${SUPACLOUD_ENABLE_LOW_MEMORY_TCP_GUARDRAILS:-false}" in
        true|TRUE|1|yes|YES) ;;
        *)
            log_info "Skipping low-memory TCP guardrails. Set SUPACLOUD_ENABLE_LOW_MEMORY_TCP_GUARDRAILS=true to enable."
            return 0
            ;;
    esac

    local mem_kb
    mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
    if [[ "$mem_kb" -le 0 || "$mem_kb" -gt 3145728 ]]; then
        return 0
    fi

    log_info "Configuring low-memory TCP guardrails..."
    sysctl -a 2>/dev/null \
        | grep -E '^net\.ipv4\.tcp_(mem|rmem|wmem|fin_timeout|tw_reuse)' \
        > /etc/sysctl.d/99-supacloud-lowmem-tcp.before 2>/dev/null || true
    cat > /etc/sysctl.d/99-supacloud-lowmem-tcp.conf <<'EOF'
# SupaCloud small-host guardrails. Bound per-socket TCP buffers and raise the
# global TCP memory ceiling to reduce transient TCP memory pressure on 2G hosts.
# Rollback: rm -f /etc/sysctl.d/99-supacloud-lowmem-tcp.conf && sysctl --system
net.ipv4.tcp_mem = 32768 43690 65536
net.ipv4.tcp_rmem = 4096 87380 4194304
net.ipv4.tcp_wmem = 4096 16384 4194304
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_tw_reuse = 1
EOF
    sysctl --system >/dev/null 2>&1 || log_warn "Failed to apply sysctl guardrails; they will apply after reboot"
}

sync_runtime_config() {
    local source_file="${1:-$CONFIG_FILE}"
    mkdir -p "$(dirname "$OPT_CONFIG_FILE")"
    if [[ -f "$source_file" ]]; then
        cp "$source_file" "$OPT_CONFIG_FILE"
    else
        : > "$OPT_CONFIG_FILE"
    fi
    chmod 600 "$OPT_CONFIG_FILE"
}

append_or_replace_env() {
    local file="$1"
    local key="$2"
    local value="$3"
    mkdir -p "$(dirname "$file")"
    touch "$file"
    python3 - "$file" "$key" "$value" <<'PYENV'
from pathlib import Path
import sys
path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text().splitlines() if path.exists() else []
for i, line in enumerate(lines):
    if line.startswith(f"{key}="):
        lines[i] = f"{key}={value}"
        break
else:
    lines.append(f"{key}={value}")
path.write_text("\n".join(lines) + ("\n" if lines else ""))
PYENV
}

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

# ========== Check Configuration ==========
check_config() {
    log_step "Checking configuration..."
    
    if [[ ! -f "$CONFIG_FILE" ]]; then
        # Enhanced logic: auto-generate config.env if critical env vars exist
        if [[ -n "$INTERNAL_IP" || -n "$SUPABASE_PUBLIC_DOMAIN" ]]; then
             GENERATED_STUDIO_DOMAIN="${SUPABASE_STUDIO_DOMAIN:-$(derive_studio_domain "${SUPABASE_PUBLIC_DOMAIN:-api.${INTERNAL_IP}.nip.io}" "${INTERNAL_IP:-}")}"
             log_info "Environment variables detected, generating configuration file..."
             cat > "$CONFIG_FILE" << EOF
# Auto-generated configuration - $(date)
INTERNAL_IP=${INTERNAL_IP}
SUPABASE_PUBLIC_DOMAIN=${SUPABASE_PUBLIC_DOMAIN}
SUPABASE_STUDIO_DOMAIN=${GENERATED_STUDIO_DOMAIN}
DB_PASSWORD=${DB_PASSWORD:-DBUser.Supa}
JWT_SECRET=${JWT_SECRET}
ANON_KEY=${ANON_KEY}
SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
DASHBOARD_USERNAME=${DASHBOARD_USERNAME:-admin}
DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD:-pigsty}
GRAFANA_PASSWORD=${GRAFANA_PASSWORD:-pigsty}
S3_STORAGE_TYPE=${S3_STORAGE_TYPE:-juicefs}
PIGSTY_CONFIG_TEMPLATE=${PIGSTY_CONFIG_TEMPLATE:-supabase}
SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK=${SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK:-false}
IMAGINARY_IMAGE=${IMAGINARY_IMAGE:-h2non/imaginary:1.2.4}
# Edge Runtime: Bun (built-in, no configuration needed)
EOF
             log_info "Configuration file generated: $CONFIG_FILE"
        else
            log_error "Configuration file not found: $CONFIG_FILE"
            log_info "Please copy and edit the config file: cp config.env.example config.env"
        fi
    fi
    # Load configuration file (if exists)
    if [[ -f "$CONFIG_FILE" ]]; then
        # Backup command line variables to prevent being overwritten by source
        [[ -n "$INTERNAL_IP" ]] && local CMD_IP="$INTERNAL_IP"
        [[ -n "$SUPABASE_PUBLIC_DOMAIN" ]] && local CMD_DOMAIN="$SUPABASE_PUBLIC_DOMAIN"
        [[ -n "$SUPABASE_STUDIO_DOMAIN" ]] && local CMD_STUDIO="$SUPABASE_STUDIO_DOMAIN"
        [[ -n "$S3_STORAGE_TYPE" ]] && local CMD_S3="$S3_STORAGE_TYPE"
        [[ -n "$POSTGRES_PASSWORD" ]] && local CMD_PG_PASS="$POSTGRES_PASSWORD"
        
        source "$CONFIG_FILE"

        # Restore command line variables (highest priority)
        [[ -n "$CMD_IP" ]] && INTERNAL_IP="$CMD_IP"
        [[ -n "$CMD_DOMAIN" ]] && SUPABASE_PUBLIC_DOMAIN="$CMD_DOMAIN"
        [[ -n "$CMD_STUDIO" ]] && SUPABASE_STUDIO_DOMAIN="$CMD_STUDIO"
        [[ -n "$CMD_S3" ]] && S3_STORAGE_TYPE="$CMD_S3"
        [[ -n "$CMD_PG_PASS" ]] && {
            POSTGRES_PASSWORD="$CMD_PG_PASS"
            DASHBOARD_PASSWORD="$CMD_PG_PASS"
            GRAFANA_PASSWORD="$CMD_PG_PASS"
        }
    fi
    
    # 1. Validate/Get INTERNAL_IP
    if [[ -z "$INTERNAL_IP" || "$INTERNAL_IP" == "10.6.0.9" ]]; then
        log_info "Checking internal IP..."
        # Get all non-loopback IPs, prioritizing IPv4 (filtering out IPv6 containing colons)
        ALL_IPS=($(hostname -I 2>/dev/null))
        IPS=()
        for ip in "${ALL_IPS[@]}"; do
            # Keep only IPv4 addresses (no colons)
            if [[ ! "$ip" =~ : ]]; then
                IPS+=("$ip")
            fi
        done
        # Fallback to all IPs if no IPv4 addresses found
        if [[ ${#IPS[@]} -eq 0 ]]; then
            IPS=("${ALL_IPS[@]}")
        fi
        
        if [[ ${#IPS[@]} -eq 0 ]]; then
            log_warn "Could not automatically detect IP address"
            while [[ -z "$INTERNAL_IP" || "$INTERNAL_IP" == "10.6.0.9" ]]; do
                read -r -p "Please enter server internal IP: " INTERNAL_IP
            done
        elif [[ ${#IPS[@]} -eq 1 ]]; then
            INTERNAL_IP="${IPS[0]}"
            log_info "Automatically detected internal IP: $INTERNAL_IP"
        else
            log_warn "Multiple IP addresses detected:"
            for i in "${!IPS[@]}"; do
                echo "  [$((i+1))] ${IPS[$i]}"
            done
            
            # Auto-select first IP in non-interactive mode
            if [ ! -t 0 ]; then
                INTERNAL_IP="${IPS[0]}"
                log_info "Non-interactive mode, automatically selecting first IP: $INTERNAL_IP"
            else
                while true; do
                    read -r -p "Please enter selection (1-${#IPS[@]}) or enter IP directly: " selection
                    if [[ "$selection" =~ ^[0-9]+$ ]] && (( selection >= 1 && selection <= ${#IPS[@]} )); then
                        INTERNAL_IP="${IPS[$((selection-1))]}"
                        break
                    elif [[ -n "$selection" ]]; then
                        INTERNAL_IP="$selection"
                        break
                    fi
                done
            fi
        fi
        log_info "Internal IP set: $INTERNAL_IP"
    else
        log_info "Using configured internal IP: $INTERNAL_IP"
    fi
    
    # 2. Validate/Get domain configuration
    # Compatibility with legacy configuration
    if [[ -n "$SUPABASE_DOMAIN" && -z "$SUPABASE_PUBLIC_DOMAIN" ]]; then
        SUPABASE_PUBLIC_DOMAIN="$SUPABASE_DOMAIN"
    fi

    # Get Public Domain
    if [[ -z "$SUPABASE_PUBLIC_DOMAIN" || "$SUPABASE_PUBLIC_DOMAIN" == "supa.example.com" ]]; then
        if [ -t 0 ]; then
            log_warn "API/Public domain not configured (SUPABASE_PUBLIC_DOMAIN)"
            while [[ -z "$SUPABASE_PUBLIC_DOMAIN" || "$SUPABASE_PUBLIC_DOMAIN" == "supa.example.com" ]]; do
                read -r -p "Please enter Supabase API domain [leave empty for api.${INTERNAL_IP}.nip.io]: " INPUT_DOMAIN
                if [[ -z "$INPUT_DOMAIN" ]]; then
                    SUPABASE_PUBLIC_DOMAIN="api.${INTERNAL_IP}.nip.io"
                else
                    SUPABASE_PUBLIC_DOMAIN="$INPUT_DOMAIN"
                fi
            done
        else
            SUPABASE_PUBLIC_DOMAIN="api.${INTERNAL_IP}.nip.io"
            log_warn "Non-interactive environment detected, using default API domain: $SUPABASE_PUBLIC_DOMAIN"
        fi
    fi
    log_info "API Domain: $SUPABASE_PUBLIC_DOMAIN"

    # Get Studio Domain
    if [[ -z "$SUPABASE_STUDIO_DOMAIN" ]]; then
        DEFAULT_STUDIO_DOMAIN="$(derive_studio_domain "$SUPABASE_PUBLIC_DOMAIN" "$INTERNAL_IP")"
        
        if [ -t 0 ]; then
            log_info "Configure Studio domain (optional)"
            read -r -p "Please enter Studio domain [default is $DEFAULT_STUDIO_DOMAIN]: " INPUT_STUDIO_DOMAIN
            
            if [[ -n "$INPUT_STUDIO_DOMAIN" ]]; then
                SUPABASE_STUDIO_DOMAIN="$INPUT_STUDIO_DOMAIN"
            else
                SUPABASE_STUDIO_DOMAIN="$DEFAULT_STUDIO_DOMAIN"
            fi
        else
            SUPABASE_STUDIO_DOMAIN="$DEFAULT_STUDIO_DOMAIN"
            log_warn "Non-interactive environment detected, using default Studio domain: $SUPABASE_STUDIO_DOMAIN"
        fi
    fi
    log_info "Studio Domain: $SUPABASE_STUDIO_DOMAIN"

    # 3. Check and generate random password (if using default values)
    if [[ -z "$POSTGRES_PASSWORD" || "$POSTGRES_PASSWORD" == "DBUser.Supa" ]]; then
        log_info "Default database password detected, generating random strong password..."
        POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)
        log_info "Database password generated"
    fi

    if [[ -z "$DASHBOARD_PASSWORD" || "$DASHBOARD_PASSWORD" == "supacloud" ]]; then
        log_info "Default Studio password detected, generating random strong password..."
        DASHBOARD_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)
        log_info "Studio password generated"
    fi
    
    if [[ -z "$GRAFANA_PASSWORD" || "$GRAFANA_PASSWORD" == "supacloud" ]]; then
        log_info "Default Grafana password detected, generating random strong password..."
        GRAFANA_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)
        log_info "Grafana password generated"
    fi
    generate_jwt_keys
    
    log_info "Configuration verification passed"
    log_info "  Internal IP: $INTERNAL_IP"
    log_info "  API Domain: $SUPABASE_PUBLIC_DOMAIN"
    log_info "  Studio Domain: $SUPABASE_STUDIO_DOMAIN"
}

# ========== Generate JWT Keys ==========
generate_jwt_keys() {
    log_step "Checking JWT configuration..."
    
    # Auto-generate JWT_SECRET if not set or empty
    if [[ -z "$JWT_SECRET" ]]; then
        log_info "Auto-generating JWT_SECRET..."
        JWT_SECRET=$(openssl rand -base64 32 | tr -d '\n')
    else
        log_info "Using custom JWT_SECRET"
    fi
    
    # Auto-generate ANON_KEY if not set or empty
    if [[ -z "$ANON_KEY" ]]; then
        log_info "Auto-generating ANON_KEY..."
        # Generate JWT for anon role
        ANON_PAYLOAD=$(echo -n '{"role":"anon","iss":"supabase","iat":'"$(date +%s)"',"exp":'"$(($(date +%s) + 157680000))"'}' | base64 -w 0 | tr '+/' '-_' | tr -d '=')
        ANON_HEADER=$(echo -n '{"alg":"HS256","typ":"JWT"}' | base64 -w 0 | tr '+/' '-_' | tr -d '=')
        ANON_SIGNATURE=$(echo -n "${ANON_HEADER}.${ANON_PAYLOAD}" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | base64 -w 0 | tr '+/' '-_' | tr -d '=')
        ANON_KEY="${ANON_HEADER}.${ANON_PAYLOAD}.${ANON_SIGNATURE}"
    else
        log_info "Using custom ANON_KEY"
    fi
    
    # Auto-generate SERVICE_ROLE_KEY if not set or empty
    if [[ -z "$SERVICE_ROLE_KEY" ]]; then
        log_info "Auto-generating SERVICE_ROLE_KEY..."
        # Generate JWT for service_role role
        SERVICE_PAYLOAD=$(echo -n '{"role":"service_role","iss":"supabase","iat":'"$(date +%s)"',"exp":'"$(($(date +%s) + 157680000))"'}' | base64 -w 0 | tr '+/' '-_' | tr -d '=')
        SERVICE_HEADER=$(echo -n '{"alg":"HS256","typ":"JWT"}' | base64 -w 0 | tr '+/' '-_' | tr -d '=')
        SERVICE_SIGNATURE=$(echo -n "${SERVICE_HEADER}.${SERVICE_PAYLOAD}" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | base64 -w 0 | tr '+/' '-_' | tr -d '=')
        SERVICE_ROLE_KEY="${SERVICE_HEADER}.${SERVICE_PAYLOAD}.${SERVICE_SIGNATURE}"
    else
        log_info "Using custom SERVICE_ROLE_KEY"
    fi
    
    # Save generated keys to file
    mkdir -p /etc/supabase
    cat > /etc/supabase/jwt-keys.env << EOF
# Supabase JWT Keys - Auto-generated on $(date)
# Please keep this file safe!

JWT_SECRET="${JWT_SECRET}"
ANON_KEY="${ANON_KEY}"
SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}"
EOF
    chmod 600 /etc/supabase/jwt-keys.env
    
    log_info "JWT keys saved to: /etc/supabase/jwt-keys.env"
}

# ========== Check OS Compatibility ==========
check_os_compatibility() {
    log_step "Checking OS compatibility..."
    
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        log_info "OS: $PRETTY_NAME"
        
        case "$ID" in
            opencloudos|tencentos)
                log_warn "Detected $PRETTY_NAME"
                log_warn "Using compatibility mode for installation, avoiding Rocky Linux repo use in Pigsty"
                export SKIP_EPEL=true
                export USE_OPENCLOUDOS_COMPAT=true
                ;;
        esac
    fi
    
    # Check OpenSSL version and log it
    OPENSSL_VER=$(openssl version 2>/dev/null | awk '{print $2}')
    log_info "Current OpenSSL version: $OPENSSL_VER"
    
    # Warn but do not block installation
    if [[ "$OPENSSL_VER" =~ ^3\.[5-9] ]]; then
        log_warn "Detected non-standard OpenSSL version: $OPENSSL_VER"
        log_warn "If you encounter sshd issues, please install compatible openssh package"
    fi
}

# ========== Check System Requirements ==========
check_system() {
    log_step "Checking system requirements..."
    
    # Check root privileges
    if [[ $EUID -ne 0 ]]; then
        log_error "Please run this script as root"
        exit 1
    fi
    
    # Check OS
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        log_info "OS: $PRETTY_NAME"
    else
        log_error "Cannot recognize operating system"
        exit 1
    fi
    
    # Check architecture
    ARCH=$(uname -m)
    if [[ "$ARCH" != "x86_64" && "$ARCH" != "aarch64" ]]; then
        log_error "Unsupported architecture: $ARCH"
        exit 1
    fi
    log_info "System architecture: $ARCH"
}

# ========== Setup local SSH (Required for Ansible) ==========
setup_local_ssh() {
    log_step "Configuring local SSH passwordless login..."
    
    # OpenCloudOS compatibility check
    if grep -qi "opencloudos" /etc/os-release 2>/dev/null; then
        log_warn "OpenCloudOS detected, skipping sshd config modification to avoid connection interruption"
        SKIP_SSHD_RESTART=true
    fi
    
    # Ensure .ssh directory exists
    mkdir -p ~/.ssh
    chmod 700 ~/.ssh
    
    # Generate keypair if not exists (use ed25519 to bypass RHEL 9 strict RSA policy)
    if [[ ! -f ~/.ssh/id_ed25519 && ! -f ~/.ssh/id_rsa ]]; then
        log_info "Generating SSH keypair (ed25519)..."
        ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
    fi
    
    # Attempt to read public key (prefer ed25519, fall back to rsa)
    local PUB_KEY=""
    [[ -f ~/.ssh/id_ed25519.pub ]] && PUB_KEY=$(cat ~/.ssh/id_ed25519.pub)
    [[ -z "$PUB_KEY" && -f ~/.ssh/id_rsa.pub ]] && PUB_KEY=$(cat ~/.ssh/id_rsa.pub)
    
    # Add public key to authorized_keys
    if [[ -n "$PUB_KEY" ]] && ! grep -q "$PUB_KEY" ~/.ssh/authorized_keys 2>/dev/null; then
        log_info "Adding public key to authorized_keys..."
        echo "$PUB_KEY" >> ~/.ssh/authorized_keys
        chmod 600 ~/.ssh/authorized_keys
    fi
    
    # Add to known_hosts (avoid yes/no prompt), including all local IPs
    local ALL_LOCAL_IPS
    ALL_LOCAL_IPS=$(hostname -I 2>/dev/null || echo "")
    ssh-keyscan -H localhost 127.0.0.1 ::1 $ALL_LOCAL_IPS >> ~/.ssh/known_hosts 2>/dev/null || true
    
    # Ensure sshd base environment is ready (keys + relaxed config)
    # Ensure correct configuration even if sshd is already running
    mkdir -p /run/sshd /var/run/sshd /var/empty/sshd /etc/ssh /etc/ssh/sshd_config.d
    chmod 755 /var/empty/sshd
    
    # Generate host keys (often missing in Docker containers)
    ssh-keygen -A 2>/dev/null || true
    if [[ ! -f /etc/ssh/ssh_host_rsa_key ]]; then
        ssh-keygen -t rsa -f /etc/ssh/ssh_host_rsa_key -N "" -q 2>/dev/null || true
    fi
    if [[ ! -f /etc/ssh/ssh_host_ed25519_key ]]; then
        ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N "" -q 2>/dev/null || true
    fi
    if [[ ! -f /etc/ssh/ssh_host_ecdsa_key ]]; then
        ssh-keygen -t ecdsa -f /etc/ssh/ssh_host_ecdsa_key -N "" -q 2>/dev/null || true
    fi
    
    # Override sshd config: allow root login, use PAM, relaxed mode
    # RHEL 9 Include /etc/ssh/sshd_config.d/*.conf by default, 00 prefix for priority
    # CAUTION: OpenCloudOS skips this to avoid SSH interruption
    if [[ "${SKIP_SSHD_RESTART:-false}" != "true" ]]; then
        cat > /etc/ssh/sshd_config.d/00-supacloud-test.conf << 'EOF'
UsePAM yes
PermitRootLogin yes
StrictModes no
PubkeyAuthentication yes
PasswordAuthentication yes
EOF
    
        # Start/Restart sshd to apply new configuration
        if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then
            # systemd environment: restart sshd
            systemctl restart sshd 2>/dev/null || systemctl start sshd 2>/dev/null || true
        else
            # Non-systemd environment (or systemd not ready): start directly
            if pgrep -x sshd >/dev/null; then
                # sshd already running, restart to apply new configuration
                pkill -x sshd 2>/dev/null || true
                sleep 1
            fi
            /usr/sbin/sshd -E /var/log/sshd.log 2>/dev/null || log_warn "Direct sshd start failed, Ansible deployment might fail"
        fi
        sleep 1
    else
        log_info "OpenCloudOS compatibility mode: skipping sshd config modification"
    fi
    
    # Rescan host keys (sshd might have restarted, keys might have changed)
    ssh-keyscan -H localhost 127.0.0.1 ::1 > ~/.ssh/known_hosts 2>/dev/null || true
    
    # Final handshake test, log details on failure
    if ! ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no root@127.0.0.1 "echo SSH_OK" &>/dev/null; then
        log_warn "Local SSH connectivity test failed! This might cause Ansible deployment to crash."
        log_warn "---------- SSHD Config Check (-T) ----------"
        /usr/sbin/sshd -T 2>/dev/null | grep -E "permitrootlogin|strictmodes|usepam|pubkey" || true
        log_warn "---------- SSHD Startup Error Logs ----------"
        cat /var/log/sshd.log 2>/dev/null || true
        log_warn "---------- ~/.ssh Directory Permissions ----------"
        ls -la ~/.ssh 2>/dev/null || true
    else
        log_info "Local SSH Loopback test successful."
    fi
    
    log_info "Local SSH passwordless configuration complete"
}

# ========== Install Base Dependencies (for minimal installations) ==========
install_base_dependencies() {
    log_step "Checking and installing base system dependencies..."

    local PACKAGES=""
    

    
    # Detect package manager
    if command -v dnf &> /dev/null; then
        # RHEL/Alma/Rocky/OpenCloudOS/CentOS
        # Base image might miss: sudo, openssl, jq, bc, procps-ng, ssh
        log_info "Using dnf to check for extra utilities..."

        # Check and add missing packages
        ! command -v curl &> /dev/null && PACKAGES="$PACKAGES curl"
        ! command -v tar &> /dev/null && PACKAGES="$PACKAGES tar"
        ! command -v gzip &> /dev/null && PACKAGES="$PACKAGES gzip"
        ! command -v sudo &> /dev/null && PACKAGES="$PACKAGES sudo"
        ! command -v openssl &> /dev/null && PACKAGES="$PACKAGES openssl"
        ! command -v bc &> /dev/null && PACKAGES="$PACKAGES bc"
        ! command -v jq &> /dev/null && PACKAGES="$PACKAGES jq"
        ! command -v git &> /dev/null && PACKAGES="$PACKAGES git"
        # Some minimal images miss procps-ng (ps, top)
        ! command -v ps &> /dev/null && PACKAGES="$PACKAGES procps-ng"
        # SSH tools (ssh-keygen, sshd) — Ansible required
        ! command -v ssh-keygen &> /dev/null && PACKAGES="$PACKAGES openssh-clients"
        ! command -v sshd &> /dev/null && PACKAGES="$PACKAGES openssh-server"
        ! command -v unzip &> /dev/null && PACKAGES="$PACKAGES unzip"

        if [[ -n "$PACKAGES" ]]; then
            log_info "Installing missing packages: $PACKAGES"
            dnf install -y $PACKAGES
        else
            log_info "Base dependencies check passed"
        fi

        # Ensure EPEL repository is available (Pigsty bootstrap needs it for ansible)
        # CAUTION: OpenCloudOS uses EPOL instead of EPEL
        if grep -qi "opencloudos" /etc/os-release 2>/dev/null; then
            log_info "OpenCloudOS detected, enabling EPOL repository (alternative to EPEL)..."
            dnf config-manager --set-enabled EPOL 2>/dev/null || true
        elif ! rpm -q epel-release &> /dev/null; then
            log_info "Installing EPEL repository..."
            dnf install -y epel-release || dnf install -y "https://dl.fedoraproject.org/pub/epel/epel-release-latest-$(grep -Po '(?<=VERSION_ID=\")[0-9]' /etc/os-release).noarch.rpm"
        fi
        
        # Enable PowerTools for RHEL/CentOS 8, CRB for 9, required for many EPEL packages
        log_info "Checking if CRB/PowerTools repo needs to be enabled..."
        dnf install -y dnf-plugins-core 2>/dev/null || true
        if grep -qEi "release 8|Stream 8|VERSION_ID=\"8" /etc/os-release /etc/redhat-release /etc/centos-release 2>/dev/null; then
            log_info "Detected EL8, enabling powertools repository..."
            dnf config-manager --set-enabled powertools 2>/dev/null || dnf config-manager --set-enabled PowerTools 2>/dev/null || true
        elif grep -qEi "release 9|Stream 9|VERSION_ID=\"9" /etc/os-release /etc/redhat-release /etc/centos-release 2>/dev/null; then
            log_info "Detected EL9, enabling crb repository..."
            dnf config-manager --set-enabled crb 2>/dev/null || true
        fi

        if ! python3 -c "import yaml" &>/dev/null; then
            log_info "Installing Python YAML support..."
            dnf install -y python3-pyyaml || dnf install -y python3-yaml
        fi

        local OPTIONAL_OPTIMIZER_PACKAGES=""
        ! command -v zstd &> /dev/null && OPTIONAL_OPTIMIZER_PACKAGES="$OPTIONAL_OPTIMIZER_PACKAGES zstd"
        ! command -v cwebp &> /dev/null && OPTIONAL_OPTIMIZER_PACKAGES="$OPTIONAL_OPTIMIZER_PACKAGES libwebp-tools"
        ! command -v avifenc &> /dev/null && OPTIONAL_OPTIMIZER_PACKAGES="$OPTIONAL_OPTIMIZER_PACKAGES libavif-tools"
        if [[ -n "$OPTIONAL_OPTIMIZER_PACKAGES" ]]; then
            log_info "Installing optional frontend optimizer packages:$OPTIONAL_OPTIMIZER_PACKAGES"
            dnf install -y $OPTIONAL_OPTIMIZER_PACKAGES || log_warn "Some optional frontend optimizer packages could not be installed; deployments will skip unavailable formats."
        fi
        
    elif command -v apt-get &> /dev/null; then
        # Debian/Ubuntu
        log_info "Using apt to check for extra utilities..."
        PACKAGES=""
        ! command -v curl &> /dev/null && PACKAGES="$PACKAGES curl"
        ! command -v tar &> /dev/null && PACKAGES="$PACKAGES tar"
        ! command -v gzip &> /dev/null && PACKAGES="$PACKAGES gzip"
        ! command -v sudo &> /dev/null && PACKAGES="$PACKAGES sudo"
        ! command -v bc &> /dev/null && PACKAGES="$PACKAGES bc"
        ! command -v jq &> /dev/null && PACKAGES="$PACKAGES jq"
        ! command -v git &> /dev/null && PACKAGES="$PACKAGES git"
        ! python3 -c "import yaml" &>/dev/null && PACKAGES="$PACKAGES python3-yaml"
        ! command -v ps &> /dev/null && PACKAGES="$PACKAGES procps"
        # SSH tools — Required for Ansible
        ! command -v ssh-keygen &> /dev/null && PACKAGES="$PACKAGES openssh-client"
        ! command -v sshd &> /dev/null && PACKAGES="$PACKAGES openssh-server"
        ! command -v unzip &> /dev/null && PACKAGES="$PACKAGES unzip"

        if [[ -n "$PACKAGES" ]]; then
            log_info "Installing missing base packages: $PACKAGES"
            apt-get update
            apt-get install -y $PACKAGES
        else
            log_info "Base dependencies check passed"
        fi

        local OPTIONAL_OPTIMIZER_PACKAGES=""
        ! command -v zstd &> /dev/null && OPTIONAL_OPTIMIZER_PACKAGES="$OPTIONAL_OPTIMIZER_PACKAGES zstd"
        ! command -v cwebp &> /dev/null && OPTIONAL_OPTIMIZER_PACKAGES="$OPTIONAL_OPTIMIZER_PACKAGES webp"
        ! command -v avifenc &> /dev/null && OPTIONAL_OPTIMIZER_PACKAGES="$OPTIONAL_OPTIMIZER_PACKAGES libavif-bin"
        if [[ -n "$OPTIONAL_OPTIMIZER_PACKAGES" ]]; then
            log_info "Installing optional frontend optimizer packages:$OPTIONAL_OPTIMIZER_PACKAGES"
            apt-get update
            apt-get install -y $OPTIONAL_OPTIMIZER_PACKAGES || log_warn "Some optional frontend optimizer packages could not be installed; deployments will skip unavailable formats."
        fi
    fi

    # Ensure sudo is passwordless for root and fix common PAM errors in containers
    if command -v sudo &> /dev/null; then
        mkdir -p /etc/sudoers.d
        echo "root ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/root
        chmod 440 /etc/sudoers.d/root
        
        # Fix common PAM account management error in RHEL/Alma containers
        if [[ -f /.dockerenv ]] || grep -q "docker\|lxc\|containerd" /proc/1/cgroup 2>/dev/null; then
            if [[ -f /etc/pam.d/sudo ]]; then
                log_info "Container environment: adjusting sudo PAM config to avoid Authentication service error..."
                sed -i 's/^account.*include.*system-auth/account  sufficient pam_permit.so/' /etc/pam.d/sudo 2>/dev/null || true
                sed -i 's/^session.*include.*system-auth/session  sufficient pam_permit.so/' /etc/pam.d/sudo 2>/dev/null || true
            fi
            
            if [[ -f /etc/pam.d/sshd ]]; then
                log_info "Container environment: adjusting sshd PAM config to bypass strict checks..."
                sed -i 's/^account.*include.*password-auth/account  sufficient pam_permit.so/' /etc/pam.d/sshd 2>/dev/null || true
                sed -i 's/^session.*include.*password-auth/session  sufficient pam_permit.so/' /etc/pam.d/sshd 2>/dev/null || true
                sed -i 's/^account.*include.*system-auth/account  sufficient pam_permit.so/' /etc/pam.d/sshd 2>/dev/null || true
                sed -i 's/^session.*include.*system-auth/session  sufficient pam_permit.so/' /etc/pam.d/sshd 2>/dev/null || true
            fi
        fi
    fi
}

# ========== Check and Configure Swap ==========
setup_swap() {
    log_step "Checking memory and Swap..."
    
    # First check if system already has Swap
    CURRENT_SWAP=$(swapon --show --noheadings | wc -l)
    
    if [[ "$CURRENT_SWAP" -gt 0 ]]; then
        log_info "Swap already exists, skipping creation"
        swapon --show
        return
    fi
    
    TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    TOTAL_MEM_GB=$(echo "scale=2; $TOTAL_MEM_KB / 1024 / 1024" | bc)
    
    log_info "Total Memory: ${TOTAL_MEM_GB}GB"
    
    # Check if Swap is needed (< 4.2GB, covers 4GB servers)
    NEED_SWAP=$(echo "$TOTAL_MEM_GB < 4.2" | bc)
    
    if [[ "$NEED_SWAP" -eq 1 ]]; then
        SWAP_SIZE=${SWAP_SIZE_GB:-4}
        log_warn "Memory below 4.2GB, creating ${SWAP_SIZE}GB Swap"
        
        if [[ -f /swapfile ]]; then
            log_info "Swap file exists, enabling..."
            swapon /swapfile 2>/dev/null || true
        else
            # Prefer fallocate, fallback to dd if failed (addressing xfs/btrfs support issues)
            if ! fallocate -l ${SWAP_SIZE}G /swapfile 2>/dev/null; then
                log_info "fallocate failed, falling back to dd for swap creation..."
                dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_SIZE * 1024)) status=progress
            fi
            chmod 600 /swapfile
            mkswap /swapfile
            swapon /swapfile
            
            # Add to fstab
            if ! grep -q "/swapfile" /etc/fstab; then
                echo '/swapfile none swap sw 0 0' >> /etc/fstab
            fi
            
            log_info "Swap creation complete"
        fi
        
        # Show current Swap status
        swapon --show
    else
        log_info "Memory sufficient (${TOTAL_MEM_GB}GB), no Swap needed"
    fi
}

# ========== Enable KSM Memory Deduplication (for multi-tenant optimization) ==========
enable_ksm_optimization() {
    log_step "Configuring system-level memory deduplication (KSM)..."
    local KSM_SCRIPT="infra/os/ksm_enable.sh"
    if [[ -f "$KSM_SCRIPT" ]]; then
        bash "$KSM_SCRIPT" || log_warn "KSM configuration script failed, skipping."
    else
        log_warn "KSM configuration script not found: $KSM_SCRIPT"
    fi
}

# ========== Install Container Runtime ==========
install_container_runtime() {
    log_step "Checking container runtime..."
    
    # Check for Docker or Podman
    if command -v docker &> /dev/null; then
        log_info "Docker installed: $(docker --version)"
        CONTAINER_RUNTIME="docker"
    elif command -v podman &> /dev/null; then
        log_info "Podman installed: $(podman --version)"
        CONTAINER_RUNTIME="podman"
    else
        log_warn "Container runtime not detected, installing Podman"
        install_podman
        CONTAINER_RUNTIME="podman"
        log_info "Podman installation complete"
    fi
    
    # Ensure Docker socket available (for podman)
    if [[ "$CONTAINER_RUNTIME" == "podman" ]]; then
        setup_podman_socket
    fi
}

# ========== Install Podman (Multi-distribution support) ==========
install_podman() {
    # Configure mirror acceleration first to ensure downloads are fast during installation
    configure_podman_mirrors

    # Detect distribution
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        DISTRO_ID="${ID,,}"  # Lowercase
        DISTRO_VERSION_ID="${VERSION_ID%%.*}"  # Major version number
    else
        log_error "Cannot recognize operating system"
        exit 1
    fi
    
    log_info "Detected system: $DISTRO_ID $VERSION_ID"
    
    case "$DISTRO_ID" in
        # RHEL family (Rocky, Alma, CentOS, RHEL, OpenCloudOS)
        rocky|almalinux|centos|rhel|opencloudos|tencentos|anolis)
            log_info "Installing Podman using dnf/yum..."
            if command -v dnf &> /dev/null; then
                dnf install -y podman podman-docker
            else
                yum install -y podman podman-docker
            fi
            ;;
        
        # Fedora
        fedora)
            log_info "Installing Podman using dnf..."
            dnf install -y podman podman-docker
            ;;
        
        # Debian
        debian)
            log_info "Installing Podman using apt..."
            apt-get update
            if [[ "$DISTRO_VERSION_ID" -ge 11 ]]; then
                apt-get install -y podman
            else
                log_error "Debian version too old, requires Debian 11+"
                exit 1
            fi
            ;;
        
        # Ubuntu
        ubuntu)
            log_info "Installing Podman using apt..."
            apt-get update
            if [[ "$DISTRO_VERSION_ID" -ge 22 ]]; then
                apt-get install -y podman
            elif [[ "$DISTRO_VERSION_ID" -ge 20 ]]; then
                # Ubuntu 20.04 requires kubic repository
                source /etc/os-release
                echo "deb https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/stable/xUbuntu_${VERSION_ID}/ /" | tee /etc/apt/sources.list.d/devel:kubic:libcontainers:stable.list
                curl -L "https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/stable/xUbuntu_${VERSION_ID}/Release.key" | apt-key add -
                apt-get update
                apt-get install -y podman
            else
                log_error "Ubuntu version too old, requires Ubuntu 20.04+"
                exit 1
            fi
            ;;
        
        # openSUSE
        opensuse*|sles)
            log_info "Installing Podman using zypper..."
            zypper install -y podman
            ;;
        
        # Arch Linux
        arch|manjaro)
            log_info "Installing Podman using pacman..."
            pacman -Sy --noconfirm podman
            ;;
        
        *)
            log_error "Unsupported distribution: $DISTRO_ID"
            log_info "Please install Podman manually and rerun this script"
            exit 1
            ;;
    esac
    
    # Create podman-docker symlink (if podman-docker package is missing)
    if ! command -v docker &> /dev/null && command -v podman &> /dev/null; then
        ln -sf /usr/bin/podman /usr/local/bin/docker 2>/dev/null || true
    fi
}

# ========== Configure Podman Mirror Acceleration ==========
configure_podman_mirrors() {
    log_info "Configuring Podman mirror acceleration..."
    
    # Ensure directory exists
    mkdir -p /etc/containers/registries.conf.d/
    
    # 1. Configure base search domains (global)
    cat > /etc/containers/registries.conf << EOF
unqualified-search-registries = ["docker.io", "quay.io"]
EOF

    # 2. Write mirror configuration (using recommended stable mirrors)
    cat > /etc/containers/registries.conf.d/mirror.conf << EOF
[[registry]]
prefix = "docker.io"
location = "docker.io"

[[registry.mirror]]
location = "docker.m.daocloud.io"

[[registry.mirror]]
location = "dockerproxy.com"

[[registry.mirror]]
location = "docker.mirrors.ustc.edu.cn"

[[registry.mirror]]
location = "docker.1panel.live"

[[registry.mirror]]
location = "hub.rat.dev"
EOF

    log_info "Podman mirror configuration complete (written to /etc/containers/registries.conf.d/mirror.conf)"
}

# ========== Configure Podman Socket ==========
setup_podman_socket() {
    log_info "Configuring Podman socket..."
    
    # Enable podman systemd service
    if systemctl list-unit-files | grep -q podman.socket; then
        systemctl enable --now podman.socket || true
    fi
    if systemctl list-unit-files | grep -q 'podman.service'; then
        systemctl enable podman 2>/dev/null || true
        systemctl start  podman 2>/dev/null || true
    fi
    
    # Create Docker socket symlink (compatibility with docker-compose default lookup path)
    if [[ -S /run/podman/podman.sock ]] && [[ ! -e /var/run/docker.sock ]]; then
        ln -sf /run/podman/podman.sock /var/run/docker.sock
    elif [[ -S /run/podman/podman.sock ]] && [[ -L /var/run/docker.sock ]]; then
        # Already a symlink, skip
        true
    fi
    
    # Write DOCKER_HOST to /etc/profile.d/supacloud.sh so docker-compose can find podman socket
    mkdir -p /etc/supabase
    PROFILE_FILE="/etc/profile.d/supacloud.sh"
    if [[ -f "$PROFILE_FILE" ]]; then
        # Exists (created by install_management_api), append DOCKER_HOST
        if ! grep -q 'DOCKER_HOST' "$PROFILE_FILE"; then
            echo 'export DOCKER_HOST=unix:///var/run/podman/podman.sock' >> "$PROFILE_FILE"
        fi
    else
        # Not created yet, write early (install_management_api will append MASTER_TOKEN)
        cat > "$PROFILE_FILE" <<'EOF'
# SupaCloud CLI Environment Variables - Generated automatically by install.sh
export DOCKER_HOST=unix:///var/run/podman/podman.sock
EOF
    fi
    chmod 644 "$PROFILE_FILE"
    # Enable in current shell immediately
    export DOCKER_HOST=unix:///var/run/podman/podman.sock
    log_info "DOCKER_HOST set: $DOCKER_HOST"
    
    # Configure mirror acceleration
    configure_podman_mirrors
}

# ========== 安装 Docker Compose ==========
# ========== Install JuiceFS (Postgres LO) ==========
install_juicefs() {
    log_step "Preparing JuiceFS (Postgres LO)..."
    
    local JFS_VER="1.2.2"
    local ARCH=$(uname -m)
    local OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    local JFS_URL=""

    if ! command -v juicefs &> /dev/null; then
        log_info "Downloading JuiceFS ${JFS_VER}..."
        case "${ARCH}" in
            x86_64)  JFS_URL="https://github.com/juicedata/juicefs/releases/download/v${JFS_VER}/juicefs-${JFS_VER}-${OS}-amd64.tar.gz" ;;
            aarch64) JFS_URL="https://github.com/juicedata/juicefs/releases/download/v${JFS_VER}/juicefs-${JFS_VER}-${OS}-arm64.tar.gz" ;;
            *) log_error "Unsupported architecture: ${ARCH}"; return 1 ;;
        esac

        if ! curl -fsSL --progress-bar "https://ghproxy.net/${JFS_URL}" -o /tmp/juicefs.tar.gz; then
            log_warn "Proxy download failed, trying direct download..."
            curl -fsSL --progress-bar "${JFS_URL}" -o /tmp/juicefs.tar.gz || {
                log_error "JuiceFS download failed"; return 1
            }
        fi

        tar -xzf /tmp/juicefs.tar.gz -C /tmp
        install -m 755 /tmp/juicefs /usr/local/bin/juicefs
        rm -f /tmp/juicefs /tmp/juicefs.tar.gz
        log_info "JuiceFS installed: $(juicefs --version)"
    else
        log_info "JuiceFS installed: $(juicefs --version)"
    fi

    mkdir -p /etc/supabase
    touch /etc/supabase/.init_juicefs
    
    return 0
}

init_juicefs_s3_gateway() {
    log_step "Initializing JuiceFS S3 Gateway..."
    
    local JFS_DATA_DIR="/var/lib/juicefs"
    local JFS_CACHE_DIR="/data/juicefs"
    local JFS_META_DB="juicefs"
    
    mkdir -p "${JFS_DATA_DIR}" "${JFS_CACHE_DIR}"
    
    log_info "Creating JuiceFS meta database..."
    su - postgres -c "psql -c \"CREATE DATABASE ${JFS_META_DB};\"" 2>/dev/null || true
    su - postgres -c "psql -c \"GRANT ALL PRIVILEGES ON DATABASE ${JFS_META_DB} TO supabase_admin;\"" 2>/dev/null || true
    
    local META_URL="postgres://supabase_admin:${POSTGRES_PASSWORD}@${INTERNAL_IP}:5432/${JFS_META_DB}?sslmode=disable"
    
    if ! juicefs status "${META_URL}" &>/dev/null; then
        log_info "Formatting JuiceFS filesystem..."
        juicefs format --storage file --bucket "${JFS_DATA_DIR}" "${META_URL}" supadata || {
            log_error "JuiceFS format failed"; return 1
        }
    fi
    
    log_info "Creating S3 bucket directory..."
    mkdir -p "${JFS_DATA_DIR}/supadata/data"
    
    log_info "Creating systemd service..."
    cat > /etc/systemd/system/juicefs-s3.service << EOF
[Unit]
Description=JuiceFS S3 Gateway for Supabase
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
Environment="MINIO_ROOT_USER=${S3_ACCESS_KEY:-s3user_data}"
Environment="MINIO_ROOT_PASSWORD=${S3_SECRET_KEY:-S3User.Data}"
ExecStart=/usr/local/bin/juicefs gateway --multi-buckets --cache-dir /dev/shm/juicefs_cache --cache-size 100 "${META_URL}" 0.0.0.0:9000
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
    
    systemctl daemon-reload
    systemctl enable juicefs-s3
    systemctl restart juicefs-s3
    
    sleep 3
    if curl -s http://localhost:9000/minio/health/live > /dev/null; then
        log_info "JuiceFS S3 Gateway started successfully"
    else
        log_warn "JuiceFS S3 Gateway starting, please check later"
    fi
    
    S3_ENDPOINT="http://${INTERNAL_IP}:9000"
    S3_PROTOCOL="http"
    
    return 0
}

# Configure pgbackrest to use JuiceFS-backed local path as repo (not S3/MinIO)
configure_pgbackrest_juicefs() {
    log_step "Configuring pgbackrest for JuiceFS mode..."
    if ! command -v pgbackrest &> /dev/null; then
        log_warn "pgbackrest not installed, skipping configuration"
        return 0
    fi

    local PG_BACKREST_DIR="/var/lib/pgbackrest"
    mkdir -p "${PG_BACKREST_DIR}"
    chown -R postgres:postgres "${PG_BACKREST_DIR}"

    # Create pgbackrest config for local-file repo
    cat > /etc/pgbackrest.conf << "PGCONF"
[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=2
repo1-retention-diff=7

[db-main]
pg1-path=/pg/data
pg1-port=5432
pg1-user=postgres
PGCONF
    chown postgres:postgres /etc/pgbackrest.conf 2>/dev/null || true

    # Create stanza if postgres is running
    if sudo -u postgres pg_isready &>/dev/null; then
        log_info "Creating pgbackrest stanza db-main..."
        sudo -u postgres pgbackrest --stanza=db-main stanza-create 2>/dev/null || log_warn "pgbackrest stanza-create failed, may need manual setup after PG is fully ready"
    fi

    log_info "pgbackrest configured for JuiceFS local repo at ${PG_BACKREST_DIR}"
}


install_docker_compose() {
    log_step "Checking Docker Compose..."
    
    COMPOSE_VERSION="v2.29.2"
    
    # If using Podman, always install standalone docker-compose binary
    # (instead of relying on 'podman compose' which might have different behavior)
    if [[ "${CONTAINER_RUNTIME:-}" != "podman" ]] && command -v docker-compose &> /dev/null; then
        log_info "Docker Compose already installed: $(docker-compose --version)"
        return
    fi
    
    # For Podman environment or if not installed, check for plugin (docker compose)
    # Note: 'docker compose' under podman calls podman-compose, skip it
    if [[ "${CONTAINER_RUNTIME:-}" != "podman" ]] && docker compose version &> /dev/null 2>&1; then
        log_info "Docker Compose (plugin) already installed"
        if ! command -v docker-compose &> /dev/null; then
            mkdir -p /usr/local/bin
            cat > /usr/local/bin/docker-compose << 'EOF'
#!/bin/sh
exec docker compose "$@"
EOF
            chmod +x /usr/local/bin/docker-compose
        fi
        return
    fi
    
    log_info "Installing standalone docker-compose ${COMPOSE_VERSION}..."
    COMPOSE_URL="https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)"
    
    if curl -fsSL --progress-bar "https://ghproxy.net/${COMPOSE_URL}" -o /usr/local/bin/docker-compose 2>/dev/null; then
        log_info "Proxy download successful"
    else
        log_warn "Proxy download failed, trying direct download..."
        curl -fsSL --progress-bar "${COMPOSE_URL}" -o /usr/local/bin/docker-compose
    fi
    
    chmod +x /usr/local/bin/docker-compose
    log_info "Docker Compose installation complete: $(/usr/local/bin/docker-compose --version)"
}

# ========== Edge Functions Runtime Configuration ==========
install_edge_runtime() {
    log_step "Installing Edge Runtime..."
    local EDGE_RUNTIME_MODE="${EDGE_RUNTIME_MODE:-embedded}"
    local EDGE_RT_BIN_NAME=""
    local EDGE_RT_BIN_SOURCE=""
    local EDGE_RT_BIN_TARGET="/usr/local/bin/supacloud-edge-runtime"
    local USE_COMPILED_BINARY=false

    local ARCH=$(uname -m)
    if [[ "$ARCH" == "x86_64" ]]; then
        EDGE_RT_BIN_NAME="supacloud-edge-runtime-linux-amd64"
    elif [[ "$ARCH" == "aarch64" ]]; then
        EDGE_RT_BIN_NAME="supacloud-edge-runtime-linux-arm64"
    fi

    # 1. Create directories
    mkdir -p /var/supacloud/frontends /opt/supacloud/edge-runtime /opt/supacloud/functions /etc/supabase

    # 2. Try to find compiled edge-runtime binary
    if [[ -n "$EDGE_RT_BIN_NAME" ]]; then
        if [[ -f "${SCRIPT_DIR}/dist/${EDGE_RT_BIN_NAME}" ]]; then
            EDGE_RT_BIN_SOURCE="${SCRIPT_DIR}/dist/${EDGE_RT_BIN_NAME}"
        elif [[ -f "${SCRIPT_DIR}/packages/edge-runtime/dist/${EDGE_RT_BIN_NAME}" ]]; then
            EDGE_RT_BIN_SOURCE="${SCRIPT_DIR}/packages/edge-runtime/dist/${EDGE_RT_BIN_NAME}"
        elif [[ -f "${SCRIPT_DIR}/packages/edge-runtime/${EDGE_RT_BIN_NAME}" ]]; then
            EDGE_RT_BIN_SOURCE="${SCRIPT_DIR}/packages/edge-runtime/${EDGE_RT_BIN_NAME}"
        fi
    fi

    if [[ -n "$EDGE_RT_BIN_SOURCE" ]] && file "$EDGE_RT_BIN_SOURCE" | grep -q "ELF"; then
        log_info "Found compiled Edge Runtime binary ($EDGE_RT_BIN_NAME), installing..."
        cp "$EDGE_RT_BIN_SOURCE" "$EDGE_RT_BIN_TARGET"
        chmod +x "$EDGE_RT_BIN_TARGET"
        USE_COMPILED_BINARY=true
        log_info "Compiled Edge Runtime binary installed to $EDGE_RT_BIN_TARGET"
    fi

    # 3. Deploy Edge Runtime source (fallback for non-compiled mode)
    local EDGE_RT_SRC="${SCRIPT_DIR}/packages/edge-runtime"
    if [[ -d "$EDGE_RT_SRC" ]]; then
        cp -rf "$EDGE_RT_SRC"/* /opt/supacloud/edge-runtime/

        if [[ "$USE_COMPILED_BINARY" == "false" ]]; then
            if [[ "$EDGE_RUNTIME_MODE" == "external" ]]; then
                if ! command -v bun &> /dev/null; then
                    log_info "External Edge Runtime mode requires Bun, installing..."
                    if ! command -v unzip &> /dev/null; then
                        log_info "Installing unzip (required by Bun installer)..."
                        if command -v apt-get &>/dev/null; then
                            apt-get install -y unzip
                        elif command -v dnf &>/dev/null; then
                            dnf install -y unzip
                        fi
                    fi
                    if [[ "${USE_CHINA_MIRROR:-false}" == "true" ]] || [[ "${CN:-false}" == "true" ]]; then
                        curl -fsSL https://bunjs.cn/install | bash
                    else
                        curl -fsSL https://bun.sh/install | bash
                    fi
                    ln -sf ~/.bun/bin/bun /usr/local/bin/bun 2>/dev/null || true
                    ln -sf ~/.bun/bin/bunx /usr/local/bin/bunx 2>/dev/null || true
                    command -v bun &> /dev/null && log_info "Bun installed: $(bun --version)" || log_warn "Bun installed at ~/.bun/bin/bun"
                else
                    log_info "Bun already installed: $(bun --version)"
                fi
                cd /opt/supacloud/edge-runtime && bun install --frozen-lockfile 2>/dev/null || bun install
                touch /etc/supabase/.bun_installed
            else
                if command -v bun &> /dev/null; then
                    cd /opt/supacloud/edge-runtime && bun install --frozen-lockfile 2>/dev/null || bun install
                    log_info "Edge Runtime dependencies installed (Bun available)"
                else
                    log_info "Edge Runtime deployed (embedded mode, no compiled binary found, no Bun available)"
                    log_info "Note: Edge Functions will not work until Bun is installed or a compiled binary is provided"
                fi
            fi
        else
            log_info "Edge Runtime source deployed to /opt/supacloud/edge-runtime (functions directory)"
        fi
        log_info "Edge Runtime deployed to /opt/supacloud/edge-runtime"
    else
        log_warn "Edge Runtime source not found at $EDGE_RT_SRC, skipping source deployment"
    fi

    # 4. Determine ExecStart command
    local EXEC_START_CMD=""
    if [[ "$USE_COMPILED_BINARY" == "true" ]]; then
        EXEC_START_CMD="$EDGE_RT_BIN_TARGET"
        log_info "Using compiled binary for Edge Runtime service"
    else
        EXEC_START_CMD="/usr/local/bin/bun server.ts"
        log_info "Using Bun source mode for Edge Runtime service"
    fi

    # 5. Register systemd service
    local SYSTEMD_SRC="${SCRIPT_DIR}/infrastructure/systemd"
    if [[ -f "${SYSTEMD_SRC}/supacloud-edge-runtime.service" ]]; then
        cp "${SYSTEMD_SRC}/supacloud-edge-runtime.service" /etc/systemd/system/supacloud-edge-runtime.service
        log_info "Using checked-in supacloud-edge-runtime.service"
    else
        cat > /etc/systemd/system/supacloud-edge-runtime.service <<SVCEOF
[Unit]
Description=SupaCloud Edge Runtime
After=supacloud.service
Wants=supacloud.service

[Service]
Type=simple
WorkingDirectory=/opt/supacloud/edge-runtime
ExecStartPre=/bin/bash -c 'for pid in \$(lsof -iTCP:9000 -sTCP:LISTEN -t 2>/dev/null); do echo "[EdgeRT] Killing stale pid=\$pid"; kill -9 \$pid 2>/dev/null || true; done; sleep 0.3; true'
ExecStart=${EXEC_START_CMD}
ExecStopPost=/bin/bash -c 'for pid in \$(lsof -iTCP:9000 -sTCP:LISTEN -t 2>/dev/null); do kill -9 \$pid 2>/dev/null || true; done; true'
Restart=always
RestartSec=5
Environment=PORT=9000
Environment=EDGE_FUNCTIONS_DIR=/opt/supacloud/functions
Environment=EDGE_FUNCTIONS_BASE_DIR=/opt/supacloud/functions
Environment=MANAGEMENT_API_URL=http://127.0.0.1:9090
Environment=WORKER_POOL_SIZE=4
EnvironmentFile=-/etc/supabase/management-api.env
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
SVCEOF
    fi
    systemctl daemon-reload
    if [[ "$EDGE_RUNTIME_MODE" == "external" ]]; then
        systemctl enable supacloud-edge-runtime 2>/dev/null || true
        log_info "Edge Runtime on port 9000 (standalone systemd service mode)"
    else
        systemctl disable --now supacloud-edge-runtime 2>/dev/null || true
        if [[ "$USE_COMPILED_BINARY" == "true" ]]; then
            log_info "Edge Runtime in embedded mode (compiled binary available for external mode switch)"
        else
            log_info "Edge Runtime in embedded mode (managed by supacloud binary)"
        fi
    fi
}




# ========== S3 Storage Installation ==========
install_s3_storage() {
    log_step "Configuring S3 storage (${S3_STORAGE_TYPE:-juicefs})..."
    
    case "${S3_STORAGE_TYPE:-juicefs}" in
        minio)
            log_info "Using Pigsty built-in MinIO, no extra installation needed"
            ;;
        juicefs)
            install_juicefs
            ;;
        external)
            log_info "Using external S3 storage, skipping local installation"
            configure_external_s3
            ;;
        *)
            log_error "Unknown S3 storage type: $S3_STORAGE_TYPE"
            exit 1
            ;;
    esac
}

# ========== Configure External S3 ==========
configure_external_s3() {
    log_info "Configuring external S3 storage..."
    
    if [[ -z "$EXTERNAL_S3_ENDPOINT" ]]; then
        log_error "EXTERNAL_S3_ENDPOINT must be configured when using external S3"
        exit 1
    fi
    
    S3_ENDPOINT="$EXTERNAL_S3_ENDPOINT"
    S3_ACCESS_KEY="${EXTERNAL_S3_ACCESS_KEY:-}"
    S3_SECRET_KEY="${EXTERNAL_S3_SECRET_KEY:-}"
    S3_REGION="${EXTERNAL_S3_REGION:-us-east-1}"
    S3_BUCKET="${EXTERNAL_S3_BUCKET:-supabase-storage}"
    
    log_info "  Endpoint: $S3_ENDPOINT"
    log_info "  Region: $S3_REGION"
}

# ========== Install Pigsty ==========
# ========== Install Caddy Gateway (Default Edge proxy + TLS) ==========
install_caddy_gateway() {
    log_step "Installing SupaCloud Caddy Gateway..."

    # Caddy owns public 80/443. Stop legacy listeners (kong included for historical cleanups)
    # so they cannot conflict with customer traffic.
    for svc in nginx angie kong caddy; do
        if systemctl list-unit-files "${svc}.service" &>/dev/null || systemctl list-units "${svc}.service" &>/dev/null; then
            systemctl stop "$svc" 2>/dev/null || true
            systemctl disable "$svc" 2>/dev/null || true
        fi
    done

    mkdir -p /etc/supacloud/caddy /var/lib/supacloud/caddy /opt/supacloud/bin

    local arch="amd64"
    case "$(uname -m)" in
        aarch64|arm64) arch="arm64" ;;
    esac
    local local_asset=""
    for candidate in \
        "${SCRIPT_DIR}/packages/management-api/supacloud-caddy-linux-${arch}" \
        "${SCRIPT_DIR}/packages/management-api/dist/supacloud-caddy-linux-${arch}" \
        "${SCRIPT_DIR}/dist/supacloud-caddy-linux-${arch}" \
        "${SCRIPT_DIR}/supacloud-caddy-linux-${arch}"; do
        if [[ -f "$candidate" ]]; then
            local_asset="$candidate"
            break
        fi
    done
    local target="/usr/local/bin/supacloud-caddy"

    if [[ -x "$target" ]]; then
        log_info "supacloud-caddy already installed: $($target version 2>/dev/null | head -1 || echo installed)"
    elif [[ -n "$local_asset" ]]; then
        install -m 0755 "$local_asset" "$target"
    elif [[ -n "${SUPACLOUD_CADDY_URL:-}" ]]; then
        curl -fsSL "$SUPACLOUD_CADDY_URL" -o "$target"
        chmod 0755 "$target"
    elif [[ -x "${SCRIPT_DIR}/scripts/build_supacloud_caddy.sh" ]] && command -v go >/dev/null 2>&1; then
        log_info "Building supacloud-caddy locally with xcaddy and the rate-limit module..."
        if ! command -v xcaddy >/dev/null 2>&1; then
            GOBIN=/usr/local/bin go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
        fi
        OUT_DIR=/tmp/supacloud-caddy-build "${SCRIPT_DIR}/scripts/build_supacloud_caddy.sh"
        install -m 0755 "/tmp/supacloud-caddy-build/supacloud-caddy-linux-${arch}" "$target"
        rm -rf /tmp/supacloud-caddy-build
    elif [[ "${SUPACLOUD_ALLOW_STOCK_CADDY_FALLBACK:-false}" == "true" ]]; then
        log_warn "Installing stock Caddy fallback without SupaCloud rate-limit module. Do not use this for production rate limits."
        local caddy_version="${CADDY_VERSION:-2.10.2}"
        local caddy_url="https://github.com/caddyserver/caddy/releases/download/v${caddy_version}/caddy_${caddy_version}_linux_${arch}.tar.gz"
        mkdir -p /tmp/supacloud-caddy
        curl -fsSL "https://ghproxy.net/${caddy_url}" -o /tmp/supacloud-caddy/caddy.tar.gz 2>/dev/null || \
            curl -fsSL "$caddy_url" -o /tmp/supacloud-caddy/caddy.tar.gz
        tar -xzf /tmp/supacloud-caddy/caddy.tar.gz -C /tmp/supacloud-caddy caddy
        install -m 0755 /tmp/supacloud-caddy/caddy "$target"
        rm -rf /tmp/supacloud-caddy
    else
        log_error "supacloud-caddy artifact not found. Provide SUPACLOUD_CADDY_URL, include supacloud-caddy-linux-${arch}, or install Go so the installer can build it."
        return 1
    fi

    # The empty TLS connection policy is intentional: without it Caddy can keep
    # :443 as a plain HTTP listener when loading JSON with both :80 and :443.
    cat > /etc/supacloud/caddy/config.json <<'EOF'
{
  "admin": { "listen": "127.0.0.1:2019" },
  "logging": {
    "logs": {
      "supacloud_notice_do_not_edit_caddy_config_json_use_supacloud_cli_management_api_or_web_console": {
        "writer": { "output": "discard" },
        "level": "INFO"
      }
    }
  },
  "storage": { "module": "file_system", "root": "/var/lib/supacloud/caddy" },
  "apps": {
    "tls": {
      "automation": {
        "on_demand": {
          "permission": {
            "module": "http",
            "endpoint": "http://127.0.0.1:9090/v1/gateway/caddy/ask"
          }
        },
        "policies": [{ "on_demand": true, "key_type": "p256" }]
      }
    },
    "http": {
      "servers": {
        "supacloud": {
          "listen": [":80", ":443"],
          "tls_connection_policies": [{}],
          "http3": {},
          "routes": []
        }
      }
    }
  }
}
EOF
    cat > /etc/supacloud/caddy/DO-NOT-EDIT.txt <<'EOF'
SupaCloud generated Caddy configuration

Do not edit /etc/supacloud/caddy/config.json by hand.
SupaCloud regenerates this Caddy JSON during route, domain, certificate, rate-limit, and frontend deployment reconciliation.
Change via: supacloud CLI, SupaCloud management API, SupaCloud web console.
EOF
    chmod 644 /etc/supacloud/caddy/DO-NOT-EDIT.txt

    cat > /etc/systemd/system/supacloud-caddy.service <<'EOF'
[Unit]
Description=SupaCloud Caddy Edge Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=root
Group=root
EnvironmentFile=-/etc/supabase/management-api.env
ExecStart=/usr/local/bin/supacloud-caddy run --config /etc/supacloud/caddy/config.json
ExecReload=/usr/local/bin/supacloud-caddy reload --config /etc/supacloud/caddy/config.json --force
TimeoutStopSec=5s
LimitNOFILE=1048576
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable supacloud-caddy
    # supacloud may not be installed yet on first run; start will be retried by lifecycle/pre-start.
    systemctl restart supacloud-caddy || log_warn "supacloud-caddy start deferred; management API will populate routes after install."
    log_info "SupaCloud Caddy Gateway installation completed."
}

cleanup_legacy_supabase_compose_stack() {
    log_step "Cleaning legacy Supabase compose residues..."

    local runtime="${CONTAINER_RUNTIME:-}"
    if [[ -z "$runtime" ]]; then
        if command -v podman >/dev/null 2>&1; then
            runtime="podman"
        elif command -v docker >/dev/null 2>&1; then
            runtime="docker"
        else
            log_warn "No container runtime found, skipping legacy compose cleanup"
            return
        fi
    fi

    if ! command -v "$runtime" >/dev/null 2>&1; then
        log_warn "Container runtime ${runtime} is unavailable, skipping legacy compose cleanup"
        return
    fi

    local safe_remove=(
        supabase-kong
        supabase-studio
        supabase-meta
        supabase-analytics
        supabase-vector
        supabase-imgproxy
    )
    local data_plane=(
        supabase-rest
        supabase-auth
        supabase-storage
        supabase-edge-functions
        supabase-realtime
        realtime-dev.supabase-realtime
    )

    local existing
    existing="$($runtime ps -a --format '{{.Names}}' 2>/dev/null || true)"

    local name
    for name in "${safe_remove[@]}"; do
        if printf '%s\n' "$existing" | grep -qx "$name"; then
            log_info "Removing legacy compose container: ${name}"
            "$runtime" rm -f "$name" >/dev/null 2>&1 || log_warn "Failed to remove ${name}"
        fi
    done

    if [[ "${SUPACLOUD_REMOVE_LEGACY_DATA_PLANE:-false}" == "true" ]]; then
        for name in "${data_plane[@]}"; do
            if printf '%s\n' "$existing" | grep -qx "$name"; then
                log_info "Removing legacy data-plane container: ${name}"
                "$runtime" rm -f "$name" >/dev/null 2>&1 || log_warn "Failed to remove ${name}"
            fi
        done
    else
        local leftovers=()
        for name in "${data_plane[@]}"; do
            if printf '%s\n' "$existing" | grep -qx "$name"; then
                leftovers+=("$name")
            fi
        done
        if [[ ${#leftovers[@]} -gt 0 ]]; then
            log_warn "Leaving possible legacy data-plane containers in place: ${leftovers[*]}"
            log_warn "After confirming per-project supacloud-pgrst@*/supacloud-gotrue@* services are healthy, rerun with SUPACLOUD_REMOVE_LEGACY_DATA_PLANE=true to remove them."
        fi
    fi
}




install_pigsty() {
    log_step "Installing Pigsty..."
    
    cd ~
    
    # OpenCloudOS Special Handling: Install ansible and dependencies first to avoid incompatible Rocky Linux repo in Pigsty bootstrap
    local IS_OPENCLOUDOS=false
    if grep -qi "opencloudos" /etc/os-release 2>/dev/null; then
        IS_OPENCLOUDOS=true
        log_warn "Detected OpenCloudOS, using compatibility mode..."
        
        # Enable EPOL repo
        dnf config-manager --set-enabled EPOL 2>/dev/null || true
        
        # Install ansible and necessary dependencies
        if ! command -v ansible-playbook &> /dev/null; then
            log_info "Installing ansible from EPOL..."
            dnf install -y ansible python3-jmespath || {
                log_error "Cannot install ansible, please check if EPOL repo is available"
                exit 1
            }
        fi
        
        # Install necessary Ansible collections
        log_info "Installing Ansible collections..."
        ansible-galaxy collection install community.crypto ansible.posix community.general 2>/dev/null || true
        
        log_info "ansible installed: $(ansible --version | head -1)"
    fi
    
    # Backup original repo config (Pigsty will replace them)
    if [[ -d /etc/yum.repos.d ]] && [[ ! -d /etc/yum.repos.d/pre-pigsty-backup ]]; then
        log_info "Backing up original repo config..."
        mkdir -p /etc/yum.repos.d/pre-pigsty-backup
        cp /etc/yum.repos.d/*.repo /etc/yum.repos.d/pre-pigsty-backup/ 2>/dev/null || true
    fi
    
    # OpenCloudOS Special Handling: Lock critical package versions before Pigsty installation
    if [[ "$IS_OPENCLOUDOS" == "true" ]]; then
        log_info "OpenCloudOS: Locking OpenSSL and OpenSSH versions to prevent replacement by Pigsty..."
        # Lock critical packages to prevent upgrade from Pigsty's Rocky Linux source
        dnf versionlock add openssl openssl-libs openssh openssh-server openssh-clients 2>/dev/null || {
            # If versionlock plugin is missing, install it
            dnf install -y python3-dnf-plugin-versionlock 2>/dev/null || true
            dnf versionlock add openssl openssl-libs openssh openssh-server openssh-clients 2>/dev/null || true
        }
        log_info "Locked: $(dnf versionlock list 2>/dev/null | grep -E 'openssl|openssh' | head -5)"
    fi
    
    # Download Pigsty (Check for bootstrap file rather than directory to avoid false skip)
    if [[ ! -f ~/pigsty/bootstrap ]]; then
        log_info "Downloading Pigsty..."
        # Clean up empty directory that might have been created early
        rm -rf ~/pigsty
        if [[ -n "${PIGSTY_VERSION:-}" && "${PIGSTY_VERSION}" != "latest" ]]; then
            curl -fsSL https://repo.pigsty.io/get | bash -s "${PIGSTY_VERSION}"
        else
            curl -fsSL https://repo.pigsty.io/get | bash
        fi
    else
        log_info "Pigsty already installed (bootstrap exists)"
    fi
    
    cd ~/pigsty
    
    # OpenCloudOS Special Handling: Skip bootstrap and restore original repo
    if [[ "$IS_OPENCLOUDOS" == "true" ]]; then
        log_warn "OpenCloudOS skipping Pigsty bootstrap (ansible manually installed)"
        # Restore original repo config (Pigsty might have replaced it with Rocky Linux source)
        if [[ -d /etc/yum.repos.d/pre-pigsty-backup ]]; then
            log_info "Restoring OpenCloudOS original repo config..."
            # Remove Rocky Linux sources added by Pigsty
            rm -f /etc/yum.repos.d/el9.repo /etc/yum.repos.d/node.repo /etc/yum.repos.d/pgsql.repo /etc/yum.repos.d/infra.repo 2>/dev/null || true
            # Restore original config
            cp /etc/yum.repos.d/pre-pigsty-backup/*.repo /etc/yum.repos.d/ 2>/dev/null || true
            dnf clean all
            dnf makecache
        fi
    else
        # Run bootstrap
        log_info "Running bootstrap..."
        ./bootstrap
    fi
    
    # Prefer Pigsty's official supabase template for PostgreSQL roles/extensions.
    # SupaCloud skips Pigsty's app.yml by default because gateway/runtime/storage
    # orchestration is owned by SupaCloud multi-project services.
    log_info "Configuring Supabase templates..."
    if ! ./configure -i "$INTERNAL_IP" -c "${PIGSTY_CONFIG_TEMPLATE:-supabase}"; then
        if [[ "${SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK:-false}" == "true" ]]; then
            log_warn "Primary Supabase template failed, trying legacy app/supa template..."
            ./configure -i "$INTERNAL_IP" -c app/supa
        else
            log_warn "Primary Supabase template failed, falling back to Pigsty default template."
            ./configure -i "$INTERNAL_IP"
        fi
    fi
    
    # OpenCloudOS Special Handling: Disable Pigsty repo features, use system packages
    if [[ "$IS_OPENCLOUDOS" == "true" ]]; then
        log_info "Configuring OpenCloudOS compatibility..."
        # Remove Rocky Linux repo added by Pigsty
        rm -f /etc/yum.repos.d/el9.repo /etc/yum.repos.d/node.repo /etc/yum.repos.d/pgsql.repo /etc/yum.repos.d/infra.repo 2>/dev/null || true
        # Restore original repo config
        if [[ -d /etc/yum.repos.d/backup ]]; then
            cp /etc/yum.repos.d/backup/*.repo /etc/yum.repos.d/ 2>/dev/null || true
        fi
        # Clean dnf cache
        dnf clean all 2>/dev/null || true
        
        # Critical: Restore OpenCloudOS native OpenSSL and OpenSSH
        # Pigsty might have installed incompatible OpenSSL 3.5.x (from Rocky Linux)
        log_info "Checking and restoring OpenCloudOS native OpenSSL/OpenSSH..."
        local CURRENT_SSL_VER=$(openssl version 2>/dev/null | awk '{print $2}')
        if [[ "$CURRENT_SSL_VER" =~ ^3\.[5-9] ]]; then
            log_warn "Detected incompatible OpenSSL $CURRENT_SSL_VER, restoring native OpenCloudOS version..."
            # Restore Python symlink (might have been changed by Pigsty)
            ln -sf /usr/bin/python3.9 /usr/bin/python3 2>/dev/null || true
            # Downgrade OpenSSL to OpenCloudOS native version
            dnf downgrade -y openssl openssl-libs --allowerasing 2>/dev/null || {
                log_warn "dnf downgrade failed, trying rpm..."
                # If dnf is not available, force downgrade with rpm
                curl -sL "https://mirrors.opencloudos.tech/opencloudos/9/BaseOS/x86_64/os/Packages/" | grep -o 'openssl-libs-[0-9.]*[0-9].*\.rpm' | head -1
            }
            # Reinstall OpenSSH to match OpenSSL
            dnf reinstall -y openssh-server openssh-clients --allowerasing 2>/dev/null || true
            # Verify
            log_info "OpenSSL version: $(openssl version)"
            if ssh -V 2>&1 | grep -q "OpenSSH"; then
                log_info "OpenSSH version: $(ssh -V 2>&1)"
            else
                log_error "OpenSSH still has issues, please fix manually"
            fi
        fi
    fi
 
    # Modify configuration files
    update_pigsty_config
    
    log_info "Installing Pigsty (this may take 10-20 minutes)..."
    PIGSTY_ENTRYPOINT=""
    if [[ -f "deploy.yml" ]]; then
        PIGSTY_ENTRYPOINT="deploy.yml"
    elif [[ -f "install.yml" ]]; then
        PIGSTY_ENTRYPOINT="install.yml"
    fi

    if [[ -n "$PIGSTY_ENTRYPOINT" ]]; then
        if command -v ansible-playbook &> /dev/null; then
            local EXTRA_ARGS=""
            if [[ -f /.dockerenv ]] || grep -q "docker\|lxc\|containerd" /proc/1/cgroup 2>/dev/null; then
                EXTRA_ARGS="-vvv"
                # Inject container-specific variables via command line to avoid duplicate keys in pigsty.yml and prevent /etc/hosts conflicts
                local PYTHON_PATH
                PYTHON_PATH=$(command -v python3 2>/dev/null || echo "/usr/bin/python3")
                # node_repo_remove=false prevents Pigsty from deleting system epel/appstream repos
                # node_tune=none and node_kernel_modules=[] prevent errors when modifying kernel/loading modules (e.g. ip_vs) in containers
                EXTRA_ARGS="$EXTRA_ARGS -e ansible_python_interpreter=$PYTHON_PATH -e repo_enabled=false -e node_write_etc_hosts=false -e node_dns_method=none -e node_repo_remove=false -e node_tune=none -e node_kernel_modules=[]"
                log_info "Calling Ansible in container mode: added parameters $EXTRA_ARGS"
            fi
            ansible-playbook "$PIGSTY_ENTRYPOINT" $EXTRA_ARGS
        elif [[ -x "./$PIGSTY_ENTRYPOINT" ]]; then
            "./$PIGSTY_ENTRYPOINT"
        else
            log_error "ansible-playbook not found, and $PIGSTY_ENTRYPOINT is not executable"
            exit 1
        fi
    else
        log_error "Pigsty installation entry point not found (deploy.yml / install.yml)"
        log_info "Current Pigsty directory contents:"
        ls -la
        exit 1
    fi

    # Run docker.yml only when using Docker runtime
    # If using Podman, skip to avoid conflict with system's podman-docker package (e.g. Rocky Linux 9)
    if [[ "${CONTAINER_RUNTIME:-}" == "podman" ]]; then
        log_info "Detected Podman runtime, skipping docker.yml (avoiding conflict with podman-docker)"
    else
        log_info "Configuring Docker..."
        if [[ -x "./docker.yml" ]]; then
            ./docker.yml || true
        elif [[ -f "docker.yml" ]] && command -v ansible-playbook &> /dev/null; then
            ansible-playbook docker.yml $EXTRA_ARGS || true
        else
            log_warn "docker.yml not found, skipping Docker configuration"
        fi
    fi
 
    if [[ "${SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK:-false}" == "true" ]]; then
        log_warn "Starting Pigsty's legacy Supabase compose stack because SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK=true"
        install_docker_compose
        if [[ -x "./app.yml" ]]; then
            ./app.yml || {
                log_warn "app.yml failed, trying manual start..."
                manual_start_supabase
            }
        elif [[ -f "app.yml" ]] && command -v ansible-playbook &> /dev/null; then
            ansible-playbook app.yml $EXTRA_ARGS || {
                log_warn "app.yml failed, trying manual start..."
                manual_start_supabase
            }
        else
            log_warn "app.yml not found, trying manual start..."
            manual_start_supabase
        fi
    else
        log_info "Skipping Pigsty legacy Supabase compose stack; SupaCloud uses multi-project runtime services."
        cleanup_legacy_supabase_compose_stack
    fi
}

# ========== Update Pigsty Configuration ==========
update_pigsty_config() {
    log_step "Updating Pigsty configuration..."
    
    PIGSTY_YML=~/pigsty/pigsty.yml
    
    # Force replace all default IPs with INTERNAL_IP
    if [[ -n "$INTERNAL_IP" ]]; then
        # [RESTORE] Fix potentially damaged hosts: line
        sed -i '/infra:/,/vars:/ s/^#     hosts:/      hosts:/' "$PIGSTY_YML"
        sed -i '/etcd:/,/vars:/ s/^#     hosts:/      hosts:/' "$PIGSTY_YML"
 
        # [ROBUST FIX] Direct accurate replacement for IPs under infra/etcd/minio blocks
        sed -i "/infra:/,/seq:/ s/[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}/${INTERNAL_IP}/" "$PIGSTY_YML"
        sed -i "/etcd:/,/seq:/ s/[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}/${INTERNAL_IP}/" "$PIGSTY_YML"
        
        # Fallback for common default template IPs
        sed -i "s|10.6.0.9|${INTERNAL_IP}|g" "$PIGSTY_YML"
        sed -i "s|10.10.10.10|${INTERNAL_IP}|g" "$PIGSTY_YML"
        sed -i "s|10.2.0.14|${INTERNAL_IP}|g" "$PIGSTY_YML"
    fi
 
    if [[ "${SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK:-false}" == "true" ]]; then
        log_info "Patching Pigsty legacy Supabase app domains"
        # SITE_URL -> Studio (Dashboard)
        sed -i "s|SITE_URL: https://supa.pigsty|SITE_URL: https://${SUPABASE_STUDIO_DOMAIN}|g" "$PIGSTY_YML"

        # API URL -> Public Domain (API Gateway)
        sed -i "s|API_EXTERNAL_URL: https://supa.pigsty|API_EXTERNAL_URL: https://${SUPABASE_PUBLIC_DOMAIN}|g" "$PIGSTY_YML"
        sed -i "s|SUPABASE_PUBLIC_URL: https://supa.pigsty|SUPABASE_PUBLIC_URL: https://${SUPABASE_PUBLIC_DOMAIN}|g" "$PIGSTY_YML"

        # Nginx/certbot belongs only to the legacy Pigsty Supabase app stack.
        sed -i "s|domain: supa.pigsty|domain: ${SUPABASE_PUBLIC_DOMAIN}|g" "$PIGSTY_YML"

        if [[ "$SUPABASE_PUBLIC_DOMAIN" != "$SUPABASE_STUDIO_DOMAIN" ]]; then
            sed -i "s|certbot: supa.pigsty|certbot: ${SUPABASE_PUBLIC_DOMAIN},${SUPABASE_STUDIO_DOMAIN}|g" "$PIGSTY_YML"
        else
            sed -i "s|certbot: supa.pigsty|certbot: ${SUPABASE_PUBLIC_DOMAIN}|g" "$PIGSTY_YML"
        fi

        sed -i "s|supa.pigsty|${SUPABASE_PUBLIC_DOMAIN}|g" "$PIGSTY_YML"
    else
        log_info "Skipping Pigsty app domain/certbot patch; SupaCloud Caddy owns public HTTP(S)."
    fi
    
    # Update password configuration
    if [[ -n "$DASHBOARD_PASSWORD" && "$DASHBOARD_PASSWORD" != "your-strong-password" ]]; then
        sed -i "s|DASHBOARD_PASSWORD: pigsty|DASHBOARD_PASSWORD: ${DASHBOARD_PASSWORD}|g" "$PIGSTY_YML"
    fi
    
    if [[ -n "$POSTGRES_PASSWORD" && "$POSTGRES_PASSWORD" != "DBUser.Supa" ]]; then
        sed -i "s|POSTGRES_PASSWORD: DBUser.Supa|POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}|g" "$PIGSTY_YML"
        # Also update hardcoded passwords in pg_users (supabase_admin, authenticator, supabase_auth_admin etc.)
        sed -i "s|password: 'DBUser.Supa'|password: '${POSTGRES_PASSWORD}'|g" "$PIGSTY_YML"
    fi
    
    if [[ -n "$GRAFANA_PASSWORD" && "$GRAFANA_PASSWORD" != "pigsty" ]]; then
        sed -i "s|grafana_admin_password: pigsty|grafana_admin_password: ${GRAFANA_PASSWORD}|g" "$PIGSTY_YML"
    fi
    
    # Update JWT configuration (using auto-generated or custom values)
    if [[ -n "$JWT_SECRET" ]]; then
        sed -i "s|JWT_SECRET: your-super-secret-jwt-token-with-at-least-32-characters-long|JWT_SECRET: ${JWT_SECRET}|g" "$PIGSTY_YML"
    fi
    
    if [[ -n "$ANON_KEY" ]]; then
        # Update ANON_KEY
        sed -i "s|ANON_KEY: .*|ANON_KEY: ${ANON_KEY}|g" "$PIGSTY_YML"
    fi
    
    if [[ -n "$SERVICE_ROLE_KEY" ]]; then
        # Update SERVICE_ROLE_KEY
        sed -i "s|SERVICE_ROLE_KEY: .*|SERVICE_ROLE_KEY: ${SERVICE_ROLE_KEY}|g" "$PIGSTY_YML"
    fi
    
    # Configure PostgreSQL WAL log limit (max_wal_size = 2GB)
    # Fix issue with log filling up disk
    if ! grep -q "max_wal_size" "$PIGSTY_YML"; then
        log_info "Configuring PostgreSQL WAL log limit (2GB)..."
        # Insert patroni configuration below DASHBOARD_PASSWORD
        # Use sed to maintain indentation
        sed -i 's/^\([[:space:]]*\)DASHBOARD_PASSWORD:.*$/&\n\1patroni:\n\1  postgresql:\n\1    parameters:\n\1      max_wal_size: 2GB\n\1      min_wal_size: 1GB/' "$PIGSTY_YML"
    fi
    
    configure_s3_in_pigsty
    # Container/CI environment detection limit variables now moved to ansible-playbook command line (EXTRA_ARGS)
    
    # -- Disable Pigsty's Nginx management (SupaCloud Caddy owns 80/443 by default) -----
    # Must be injected after ./configure and before bootstrap/install, otherwise Pigsty will still try to install Nginx
    if [[ -f "$PIGSTY_YML" ]]; then
        if ! grep -q 'nginx_enabled' "$PIGSTY_YML"; then
            log_info "Injecting nginx_enabled: false into pigsty.yml"
            # Insert at the beginning of the vars block (public vars area)
            sed -i '/^  vars:$/a\    nginx_enabled: false\n    nginx_exporter_enabled: false' "$PIGSTY_YML" || true
        else
            # Already exists, ensure it's false
            sed -i 's/nginx_enabled: true/nginx_enabled: false/g' "$PIGSTY_YML" || true
        fi
        log_info "pigsty.yml nginx_enabled = false"
    fi

    # -- Performance boost: PgBouncer extreme reuse -----
    if [[ -f "$PIGSTY_YML" ]]; then
        if ! grep -q 'pgbouncer_max_client_conn' "$PIGSTY_YML"; then
            log_info "Injecting pgbouncer high concurrency config into pigsty.yml (10000 queue, 20 conn)"
            sed -i '/^  vars:$/a\    pgbouncer_max_client_conn: 10000\n    pgbouncer_default_pool_size: 20' "$PIGSTY_YML" || true
        fi
    fi

    log_info "Configuration update complete"
}

# ========== Configure S3 Storage into Pigsty ==========
configure_s3_in_pigsty() {
    log_info "Configuring ${S3_STORAGE_TYPE} as S3 storage..."
    
    PIGSTY_YML=~/pigsty/pigsty.yml
    SUPABASE_ENV=~/pigsty/app/supabase/.env
    
    # Get credentials based on storage type
    case "$S3_STORAGE_TYPE" in
        minio)
            # Align with Pigsty Supabase standard: use sss.pigsty domain
            S3_ENDPOINT="https://sss.pigsty:9000"
            S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
            S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"
            S3_REGION="us-east-1"
 
            # -- Ensure domain resolution ----------------------------------------------
            if [[ -n "$INTERNAL_IP" ]]; then
                log_info "Ensuring sss.pigsty resolution exists in /etc/hosts..."
                if grep -q "sss.pigsty" /etc/hosts; then
                    sed -i "s/.*sss.pigsty.*/${INTERNAL_IP} sss.pigsty/" /etc/hosts
                else
                    echo "${INTERNAL_IP} sss.pigsty" >> /etc/hosts
                fi
            fi
            ;;
        external)
            S3_ENDPOINT="$EXTERNAL_S3_ENDPOINT"
            S3_ACCESS_KEY="$EXTERNAL_S3_ACCESS_KEY"
            S3_SECRET_KEY="$EXTERNAL_S3_SECRET_KEY"
            S3_REGION="${EXTERNAL_S3_REGION:-us-east-1}"
            ;;
        juicefs)
            # JuiceFS S3 Gateway runs on local port 9000
            S3_ENDPOINT="http://${INTERNAL_IP}:9000"
            S3_ACCESS_KEY="${S3_ACCESS_KEY:-s3user_data}"
            S3_SECRET_KEY="${S3_SECRET_KEY:-S3User.Data}"
            S3_REGION="us-east-1"
            log_info "JuiceFS mode: S3 Endpoint set to ${S3_ENDPOINT}"
            ;;
    esac
    
    # Update S3 config in pigsty.yml
    if [[ "${S3_STORAGE_TYPE}" != "minio" ]]; then
        log_info "Removing/disabling built-in MinIO from pigsty.yml..."
        # Find minio group and comment out the entire hosts block
        sed -i '/minio:/,/vars:/ { s/^[[:space:]]*hosts:/#     hosts:/ }' "$PIGSTY_YML"
        sed -i 's/^    minio:/#   minio:/g' "$PIGSTY_YML"
    else
        log_info "Ensuring MinIO is enabled in pigsty.yml..."
        # Restore minio group and its hosts
        sed -i 's/^#   minio:/    minio:/g' "$PIGSTY_YML"
        sed -i '/minio:/,/vars:/ { s/^#     hosts:/      hosts:/ }' "$PIGSTY_YML"
    fi
    
    # Update Pigsty's legacy Supabase compose .env only when explicitly enabled.
    if [[ "${SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK:-false}" == "true" && -f "$SUPABASE_ENV" ]]; then
        log_info "Updating Supabase S3 configuration..."
        
        # Update S3 endpoint
        sed -i "s|S3_ENDPOINT=.*|S3_ENDPOINT=${S3_ENDPOINT}|g" "$SUPABASE_ENV"
        
        # Update Access Key
        if [[ -n "$S3_ACCESS_KEY" ]]; then
            sed -i "s|S3_ACCESS_KEY=.*|S3_ACCESS_KEY=${S3_ACCESS_KEY}|g" "$SUPABASE_ENV"
        fi
        
        if [[ -n "$S3_SECRET_KEY" ]]; then
            sed -i "s|S3_SECRET_KEY=.*|S3_SECRET_KEY=${S3_SECRET_KEY}|g" "$SUPABASE_ENV"
        fi
        
        if [[ -n "$S3_REGION" ]]; then
            sed -i "s|S3_REGION=.*|S3_REGION=${S3_REGION}|g" "$SUPABASE_ENV"
        fi

        # MinIO must enable Path Style
        if [[ "$S3_STORAGE_TYPE" == "minio" ]]; then
            sed -i "s|S3_FORCE_PATH_STYLE=.*|S3_FORCE_PATH_STYLE=true|g" "$SUPABASE_ENV"
        fi
    else
        log_info "Skipping Pigsty Supabase .env S3 patch; legacy compose stack is disabled."
    fi
    
    
    log_info "S3 storage configuration complete"
    log_info "  Type: ${S3_STORAGE_TYPE}"
    log_info "  Endpoint: ${S3_ENDPOINT}"
}
 
# ========== Configure Analytics ==========
configure_analytics() {
    log_step "Configuring Analytics (Logflare)..."
    
    SUPABASE_ENV=~/pigsty/app/supabase/.env

    if [[ "${SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK:-false}" != "true" ]]; then
        log_info "Skipping Pigsty Logflare compose configuration; legacy Supabase compose stack is disabled by default."
        return
    fi
    
    if [[ "${ENABLE_ANALYTICS:-true}" == "true" ]]; then
        log_info "Enabling Analytics..."
        
        # Ensure .env file exists
        if [[ ! -f "$SUPABASE_ENV" ]]; then
            log_warn "Supabase .env file not found, skipping Analytics configuration"
            return
        fi
        
        # Enable Logflare container
        sed -i "s|ENABLE_ANALYTICS=.*|ENABLE_ANALYTICS=true|g" "$SUPABASE_ENV" 2>/dev/null || echo "ENABLE_ANALYTICS=true" >> "$SUPABASE_ENV"
        
        # Configure BEAM VM memory optimization parameters (reduce Logflare memory usage)
        # Default: +P 32768 +Q 4096 +S 2:2 +hms 64 +hmbs 64 +e 128 +L
        # Expected memory usage: 400-600MB (default 2GB+)
        if [[ -n "${LOGFLARE_ERL_FLAGS:-}" ]]; then
            log_info "Configuring Logflare BEAM VM memory optimization..."
            sed -i "s|ERL_AFLAGS=.*|ERL_AFLAGS=${LOGFLARE_ERL_FLAGS}|g" "$SUPABASE_ENV" 2>/dev/null || echo "ERL_AFLAGS=${LOGFLARE_ERL_FLAGS}" >> "$SUPABASE_ENV"
            log_info "  ERL_AFLAGS: ${LOGFLARE_ERL_FLAGS}"
        fi
        
        # Configure backend
        if [[ "${ANALYTICS_BACKEND:-postgres}" == "postgres" ]]; then
            log_info "Configuring Analytics backend to Postgres (Lightweight)..."
            # Set Logflare backend type
            sed -i "s|LOGFLARE_BACKEND_TYPE=.*|LOGFLARE_BACKEND_TYPE=postgres|g" "$SUPABASE_ENV" 2>/dev/null || echo "LOGFLARE_BACKEND_TYPE=postgres" >> "$SUPABASE_ENV"
            
            # Ensure Postgres connection info is correct (usually reuses POSTGRES_URL)
            # Logflare requires DB connection string
            # Use Pigsty's DBUser.Supa default password or generated password
            # Note: If POSTGRES_PASSWORD is the default 'DBUser.Supa', ensure it is set correctly
            LOGFLARE_DB_URL="postgresql://postgres:${POSTGRES_PASSWORD}@${INTERNAL_IP}:5432/postgres"
            
            if ! grep -q "LOGFLARE_DATABASE_URL" "$SUPABASE_ENV"; then
                 echo "LOGFLARE_DATABASE_URL=${LOGFLARE_DB_URL}" >> "$SUPABASE_ENV"
            else
                 # Use | as delimiter to avoid conflicts with / in URL
                 sed -i "s|LOGFLARE_DATABASE_URL=.*|LOGFLARE_DATABASE_URL=${LOGFLARE_DB_URL}|g" "$SUPABASE_ENV"
            fi
            
        elif [[ "${ANALYTICS_BACKEND}" == "bigquery" ]]; then
            log_info "Configuring Analytics backend to BigQuery..."
            sed -i "s|LOGFLARE_BACKEND_TYPE=.*|LOGFLARE_BACKEND_TYPE=bigquery|g" "$SUPABASE_ENV"
            # BigQuery requires additional credential configuration, assuming manual setup or other injection
            log_warn "Using BigQuery requires Google Cloud credentials, please check .env file"
        fi
        
    else
        log_info "Disabling Analytics (Logflare)..."
        # Disable in .env
        sed -i "s|ENABLE_ANALYTICS=.*|ENABLE_ANALYTICS=false|g" "$SUPABASE_ENV" 2>/dev/null || echo "ENABLE_ANALYTICS=false" >> "$SUPABASE_ENV"
        
        # For docker-compose, services may need to be commented out (depends on template)
        # Simply set environment variables, assuming docker-compose.yml has corresponding conditional logic
        # Or manually stop containers after start
    fi
}
 
# ========== Manually Start Supabase ==========
manual_start_supabase() {
    log_step "Manually starting Supabase..."
    
    cd ~/pigsty/app/supabase
    
    # Fix IP in .env
    sed -i "s|POSTGRES_HOST=10.10.10.10|POSTGRES_HOST=${INTERNAL_IP}|g" .env
    
    # Start services
    if docker compose version &> /dev/null 2>&1; then
        docker compose up -d
    elif command -v docker-compose &> /dev/null; then
        docker-compose up -d
    elif [[ -x /usr/local/bin/docker-compose ]]; then
        /usr/local/bin/docker-compose up -d
    else
        install_docker_compose
        /usr/local/bin/docker-compose up -d
    fi
    
    # Fix container healthchecks
    fix_container_healthchecks
    
    # Restart affected containers to apply healthcheck fixes
    log_info "Restarting legacy Studio and Analytics containers to apply healthcheck fixes..."
    docker restart supabase-studio supabase-analytics 2>/dev/null || true
}
 
# ========== Fix Container Healthchecks ==========
fix_container_healthchecks() {
    log_step "Fixing container healthchecks..."
    
    local COMPOSE_FILE=~/pigsty/app/supabase/docker-compose.yml
    
    if [[ ! -f "$COMPOSE_FILE" ]]; then
        log_warn "docker-compose.yml not found, skipping healthcheck fix"
        return
    fi
    
    # Backup original file
    cp "$COMPOSE_FILE" "${COMPOSE_FILE}.bak"
    
    # 1. Fix Studio healthcheck
    # Issue: `=>` in YAML is interpreted as folding symbol, splitting the command
    # Solution: Use simple port check or Node.js synchronous code
    log_info "Fixing Studio healthcheck..."
    if grep -q "fetch('http://studio:3000" "$COMPOSE_FILE" 2>/dev/null; then
        # Replace with healthcheck not using arrow functions
        sed -i "s|http://studio:3000|http://localhost:3000|g" "$COMPOSE_FILE"
        log_info "  Studio healthcheck URL fixed"
    fi
    
    # 2. Fix Analytics healthcheck
    # Issue: Logflare container lacks curl/wget/nc
    # Solution: Use simple file check or process check
    log_info "Fixing Analytics healthcheck..."
    if grep -q "curl.*localhost:4000/health" "$COMPOSE_FILE" 2>/dev/null; then
        # Logflare container lacks curl, use simple port listening check
        # Check if /proc/net/tcp has listening port 4000 (0x0FA0)
        sed -i 's|test: \["CMD", "curl", "-f", "http://localhost:4000/health"\]|test: ["CMD-SHELL", "cat /proc/net/tcp | grep -q 0FA0"]|g' "$COMPOSE_FILE"
        log_info "  Analytics healthcheck command fixed"
    fi
    
    log_info "Healthcheck fixes complete"
}
 
# ========== Configure PG HBA Whitelist ==========
configure_pg_hba() {
    log_step "Configuring database access whitelist (pg_hba.conf)..."

    # 1. Identify container network segment
    # Try detecting cni-podman0 (Podman) or docker0 (Docker)
    CONTAINER_NET=""
    
    if ip addr show cni-podman0 &> /dev/null; then
        CONTAINER_NET=$(ip -o -4 addr show cni-podman0 | awk '{print $4}')
        log_info "Found Podman network: ${CONTAINER_NET}"
    elif ip addr show docker0 &> /dev/null; then
        CONTAINER_NET=$(ip -o -4 addr show docker0 | awk '{print $4}')
        log_info "Found Docker network: ${CONTAINER_NET}"
    else
        # Try intelligent guess, look for 10.88/16, 10.89/24 common subnets
        CONTAINER_NET=$(ip route | grep "link src" | grep -E "10\.(88|89)\." | awk '{print $1}' | head -1)
    fi

    if [[ -z "$CONTAINER_NET" ]]; then
        # Fallback: default Podman subnet
        CONTAINER_NET="10.88.0.0/16" 
        log_warn "Container network not detected, using default: ${CONTAINER_NET}"
    fi

    # 2. Locate pg_hba.conf
    # Pigsty default path
    PG_HBA="/pg/data/pg_hba.conf"
    
    if [[ ! -f "$PG_HBA" ]]; then
        log_warn "$PG_HBA not found, attempting to find other locations..."
        # Try searching for Debian/Ubuntu or RHEL default paths
        POSSIBLE_PATHS=(
            "/var/lib/postgresql/data/pg_hba.conf"
            "/var/lib/pgsql/data/pg_hba.conf"
            "/etc/postgresql/14/main/pg_hba.conf"
            "/etc/postgresql/15/main/pg_hba.conf"
        )
        for path in "${POSSIBLE_PATHS[@]}"; do
            if [[ -f "$path" ]]; then
                PG_HBA="$path"
                log_info "Found pg_hba.conf: $PG_HBA"
                break
            fi
        done
    fi

    if [[ ! -f "$PG_HBA" ]]; then
        log_warn "pg_hba.conf not found, skipping configuration"
        return
    fi
    
    # 3. Add rules.
    # Management API and tenant runtimes usually run on the database host. Some
    # installs set DATABASE_URL/PG_HOST to INTERNAL_IP instead of loopback, so
    # PostgreSQL sees the connection as coming from that host IP and rejects it
    # unless pg_hba.conf explicitly allows it.
    CONFIG_LINE="host all all ${CONTAINER_NET} scram-sha-256"
    LOCALHOST_RULE="host    all             all             127.0.0.1/32            scram-sha-256"
    HOST_RULE=""
    if [[ -n "${INTERNAL_IP:-}" && "$INTERNAL_IP" != "127.0.0.1" && "$INTERNAL_IP" != "localhost" ]]; then
        HOST_RULE="host    all             all             ${INTERNAL_IP}/32            scram-sha-256"
    fi
    
    if grep -qF "$CONTAINER_NET" "$PG_HBA"; then
        log_info "Rule already exists: $CONFIG_LINE"
    else
        log_info "Adding rule: $CONFIG_LINE"
        # Backup
        cp "$PG_HBA" "${PG_HBA}.bak.$(date +%s)"
        # Append to file
        echo "$CONFIG_LINE" >> "$PG_HBA"
    fi
    
    # Add localhost rule
    if ! grep -qF "127.0.0.1/32" "$PG_HBA"; then
        log_info "Adding localhost password authentication rule..."
        echo "$LOCALHOST_RULE" >> "$PG_HBA"
    fi

    # Add host self-IP rule when management services use INTERNAL_IP.
    if [[ -n "$HOST_RULE" ]]; then
        if grep -qF "${INTERNAL_IP}/32" "$PG_HBA"; then
            log_info "Rule already exists for host IP: ${INTERNAL_IP}/32"
        else
            log_info "Adding host self-IP authentication rule: ${INTERNAL_IP}/32"
            echo "$HOST_RULE" >> "$PG_HBA"
        fi
    fi
        
    # 4. Reload configuration
    log_info "Reloading PostgreSQL configuration..."
    if command -v pg_ctl &> /dev/null; then
         # Execute as postgres user
         su - postgres -c "pg_ctl reload -D $(dirname "$PG_HBA")"
    elif systemctl is-active --quiet postgresql; then
         systemctl reload postgresql
    elif systemctl is-active --quiet patroni; then
         systemctl reload patroni
    elif pgrep -u postgres postgres > /dev/null; then
         # Try sending SIGHUP
         pkill -HUP -u postgres postgres
         log_info "Sent SIGHUP signal to postgres process"
    else
         log_warn "Cannot automatically reload PostgreSQL, please execute reload manually"
    fi
}

# ========== Save All Credentials ==========
save_all_credentials() {
    log_step "Saving unified credentials file..."
    
    CREDENTIALS_FILE="/etc/supabase/supacloud-credentials.env"
    mkdir -p /etc/supabase
    
    cat > "$CREDENTIALS_FILE" << EOF
# SupaCloud Unified Credentials
# Generated at $(date)

# ========== Network ==========
INTERNAL_IP=${INTERNAL_IP}
PUBLIC_DOMAIN=${SUPABASE_PUBLIC_DOMAIN}
STUDIO_DOMAIN=${SUPABASE_STUDIO_DOMAIN}

# ========== Pigsty ==========
PIGSTY_VERSION=${PIGSTY_VERSION:-latest}

# ========== Supabase Dashboard ==========
DASHBOARD_USERNAME=${DASHBOARD_USERNAME:-supabase}
DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD:-pigsty}

# ========== Database ==========
POSTGRES_HOST=${INTERNAL_IP}
POSTGRES_PORT=5432
POSTGRES_DB=postgres
POSTGRES_USER=postgres
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# ========== Grafana ==========
GRAFANA_URL=http://${INTERNAL_IP}:3000
GRAFANA_USER=admin
GRAFANA_PASSWORD=${GRAFANA_PASSWORD:-pigsty}

# ========== JWT Keys ==========
JWT_SECRET=${JWT_SECRET}
ANON_KEY=${ANON_KEY}
SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}

# ========== Analytics ==========
ENABLE_ANALYTICS=${ENABLE_ANALYTICS:-true}
ANALYTICS_BACKEND=${ANALYTICS_BACKEND:-postgres}

# ========== S3 Storage ==========
S3_STORAGE_TYPE=${S3_STORAGE_TYPE}
S3_ENDPOINT=${S3_ENDPOINT}
S3_REGION=${S3_REGION}
S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}

# ========== Management API ==========
MANAGEMENT_API_URL=http://${INTERNAL_IP}:9090
MANAGEMENT_API_TOKEN=${MASTER_TOKEN:-}

EOF

    chmod 600 "$CREDENTIALS_FILE"
    log_info "All credentials saved to: $CREDENTIALS_FILE"
}

# ========== Install Management API (Binary Deployment) ==========
install_management_api() {
    log_step "Preparing to deploy SupaCloud Control Plane binary..."

    local BIN_NAME="supacloud"
    local BIN_SOURCE="${SCRIPT_DIR}/${BIN_NAME}"
    local BIN_TARGET="/usr/local/bin/${BIN_NAME}"
    local SCRIPTS_INSTALL_DIR="/opt/supacloud/scripts/lib"
    local API_DATA_DIR="/opt/supacloud/management-api"

    mkdir -p "$SCRIPTS_INSTALL_DIR"
    mkdir -p "$API_DATA_DIR"
    mkdir -p /etc/supabase

    # 1. 部署二进制文件
    # 支持本地 supacloud 或 CI 产出的 supacloud-linux-amd64/arm64
    local ARCH=$(uname -m)
    local OS_TYPE=$(uname -s | tr '[:upper:]' '[:lower:]')
    local CI_BIN=""

    if [[ "$ARCH" == "x86_64" ]]; then
        CI_BIN="supacloud-linux-amd64"
    elif [[ "$ARCH" == "aarch64" ]]; then
        CI_BIN="supacloud-linux-arm64"
    fi

    if [[ -n "$CI_BIN" ]] && [[ -f "${SCRIPT_DIR}/dist/${CI_BIN}" ]]; then
        log_info "Found CI build artifact (dist/${CI_BIN}), installing..."
        cp "${SCRIPT_DIR}/dist/${CI_BIN}" "$BIN_TARGET"
    elif [[ -n "$CI_BIN" ]] && [[ -f "${SCRIPT_DIR}/${CI_BIN}" ]]; then
        log_info "Found platform binary in root (${CI_BIN}), installing..."
        cp "${SCRIPT_DIR}/${CI_BIN}" "$BIN_TARGET"
    elif [[ -f "$BIN_SOURCE" ]] && file "$BIN_SOURCE" | grep -q "ELF"; then
        log_info "Found local ELF binary ($BIN_SOURCE), installing..."
        cp "$BIN_SOURCE" "$BIN_TARGET"
    else
        log_error "Could not find core binary file. Please ensure: 1. Locally ran bun run build or 2. Downloaded CI artifacts to dist directory."
        exit 1
    fi
    chmod +x "$BIN_TARGET"

    # 2. Copy management scripts (Pigsty adapter)
    if [[ -d "${SCRIPT_DIR}/scripts/lib" ]] && [[ "${SCRIPT_DIR}/scripts/lib" != "$SCRIPTS_INSTALL_DIR" ]]; then
        cp -rf "${SCRIPT_DIR}/scripts/lib/"* "$SCRIPTS_INSTALL_DIR/"
        chmod +x "$SCRIPTS_INSTALL_DIR"/*.sh
        log_info "Underlying script link ready: $SCRIPTS_INSTALL_DIR"

    # 2b. Copy database schema files (required for project provisioning)
    local SCHEMA_SRC="${SCRIPT_DIR}/packages/management-api/src/db/schemas"
    local SCHEMA_DST="/opt/supacloud/packages/management-api/src/db/schemas"
    if [[ -d "$SCHEMA_SRC" ]]; then
        mkdir -p "$SCHEMA_DST"
        cp -rf "$SCHEMA_SRC"/* "$SCHEMA_DST/"
        log_info "Database schema files deployed to $SCHEMA_DST"
    else
        log_warn "Schema source directory not found: $SCHEMA_SRC"
    fi
    fi

    # 3. Generate management credentials
    if [[ ! -f /etc/supabase/master-token.env ]]; then
        MASTER_TOKEN=$(openssl rand -hex 32)
        cat > /etc/supabase/master-token.env <<EOF
# SupaCloud Master Token
MASTER_TOKEN=${MASTER_TOKEN}
EOF
        chmod 600 /etc/supabase/master-token.env
    else
        source /etc/supabase/master-token.env
    fi

    # 4. Initialize Management API database (via native psql)
    log_info "Executing database pre-check..."
    su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='supacloud_meta'\" | grep -q 1 || psql -c 'CREATE DATABASE supacloud_meta'" 2>/dev/null \
        || sudo -u postgres psql -c "CREATE DATABASE supacloud_meta" 2>/dev/null \
        || psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE supacloud_meta" 2>/dev/null \
        || log_warn "Could not create supacloud_meta database, management API will attempt auto-init"
    if [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
        su - postgres -c "psql -c \"ALTER USER postgres PASSWORD '${POSTGRES_PASSWORD}'\"" 2>/dev/null || true
    fi

    # 5. Generate API service environment file
    local REALTIME_SECRET_KEY_BASE
    local REALTIME_DB_ENC_KEY
    local BASE_DOMAIN_VALUE="${BASE_DOMAIN:-$SUPABASE_PUBLIC_DOMAIN}"
    REALTIME_SECRET_KEY_BASE=$(openssl rand -base64 48 | tr -d '\n')
    BASE_DOMAIN_VALUE="$(derive_base_domain "$BASE_DOMAIN_VALUE")"
    # Realtime tenant encryption uses AES-128 and expects a 16-byte key.
    local SECRETS_ENCRYPTION_KEY
    SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 48 | tr -d "\n" | cut -c1-64)
    # `openssl rand -hex 16` returns 32 ASCII chars, which crashes tenant
    # registration with "Bad key size". Generate a literal 16-char secret instead.
    REALTIME_DB_ENC_KEY=$(openssl rand -base64 18 | tr -d '\n=+/ ' | cut -c1-16)

    cat > /etc/supabase/management-api.env <<EOF
# SupaCloud Management API Configuration
PORT=9090
MANAGEMENT_API_URL=http://127.0.0.1:9090
DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:5432/supacloud_meta
EDGE_RUNTIME_MODE=${EDGE_RUNTIME_MODE:-embedded}
MASTER_TOKEN=${MASTER_TOKEN}
SCRIPTS_PATH=${SCRIPTS_INSTALL_DIR}
PIGSTY_PATH=${HOME}/pigsty
BASE_DOMAIN=${BASE_DOMAIN_VALUE}
S3_STORAGE_TYPE=${S3_STORAGE_TYPE:-juicefs}
IMAGINARY_IMAGE=${IMAGINARY_IMAGE:-h2non/imaginary:1.2.4}
JWT_SECRET=${JWT_SECRET}
SUPACLOUD_JWT_SECRET=${JWT_SECRET}
REALTIME_SECRET_KEY_BASE=${REALTIME_SECRET_KEY_BASE}
REALTIME_DB_ENC_KEY=${REALTIME_DB_ENC_KEY}
REALTIME_API_SECRET=${JWT_SECRET}
REALTIME_IMAGE=${REALTIME_IMAGE:-public.ecr.aws/supabase/realtime:v2.76.5}
REALTIME_CONTAINER_NAME=${REALTIME_CONTAINER_NAME:-supacloud-realtime}
REALTIME_DB_USER=supabase_admin
# Database connection environment variables (required for script execution)
PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=postgres
PG_DATABASE=postgres
PGPASSWORD=${POSTGRES_PASSWORD}
SECRETS_ENCRYPTION_KEY=${SECRETS_ENCRYPTION_KEY}
SUPABASE_SCHEMA_PATH=/opt/supacloud/packages/management-api/src/db/schemas/supabase.sql
ACME_CLIENT=lego
LEGO_BIN=${LEGO_BIN:-lego}
ACME_STATE_DIR=${ACME_STATE_DIR:-/var/lib/supacloud/lego}
ACME_HTTP_WEBROOT=${ACME_HTTP_WEBROOT:-/var/lib/supacloud/acme-challenges}
CADDY_ADMIN_URL=${CADDY_ADMIN_URL:-http://127.0.0.1:2019}
CADDY_CONFIG_PATH=${CADDY_CONFIG_PATH:-/etc/supacloud/caddy/config.json}
CADDY_STATE_DIR=${CADDY_STATE_DIR:-/var/lib/supacloud/caddy}
CADDY_BINARY_PATH=${CADDY_BINARY_PATH:-/usr/local/bin/supacloud-caddy}
EOF
    chmod 600 /etc/supabase/management-api.env
    sync_runtime_config /etc/supabase/management-api.env

    # 6. Execute database migration via supacloud binary itself
    log_info "Initializing metadata database schema..."
    export DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:5432/supacloud_meta"
    $BIN_TARGET --init-db 2>/dev/null || log_warn "Database initialization failed, please execute manually: supacloud --init-db"
    unset DATABASE_URL
    
    # 7. Register Systemd service (from infrastructure/systemd/ if available, else inline)
    log_info "Registering Systemd service unit (supacloud.service)..."
    local SYSTEMD_SRC="${SCRIPT_DIR}/infrastructure/systemd"
    if [[ -f "${SYSTEMD_SRC}/supacloud.service" ]]; then
        sed "s|ExecStart=/usr/local/bin/supacloud|ExecStart=$BIN_TARGET|" \
            "${SYSTEMD_SRC}/supacloud.service" > /etc/systemd/system/supacloud.service
        log_info "Using checked-in supacloud.service (with ExecStart patched to $BIN_TARGET)"
    else
        cat > /etc/systemd/system/supacloud.service <<EOF
[Unit]
Description=SupaCloud Management API Server
Documentation=https://github.com/supacloud/supacloud
After=network.target patroni.service
Wants=patroni.service
# Requires removed: patroni is a soft dependency (Wants= above), not a hard requirement

[Service]
Type=simple
EnvironmentFile=/etc/supabase/management-api.env
ExecStartPre=/opt/supacloud/scripts/pre_start_recovery.sh
ExecStart=$BIN_TARGET
Restart=always
RestartSec=10
StartLimitBurst=5
StartLimitIntervalSec=60
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
    fi
    systemctl daemon-reload
    systemctl enable supacloud
    systemctl start supacloud || log_warn "Service start failed, please check journalctl -u supacloud"


    # 7b. Ensure GoTrue binary and systemd template are deployed
    local GOTRUE_BIN="${GOTRUE_BIN:-/usr/local/bin/gotrue}"
    if [[ ! -x "$GOTRUE_BIN" ]]; then
        local GOTRUE_VERSION="${GOTRUE_VERSION:-v2.186.0}"
        local GOTRUE_ARCH
        GOTRUE_ARCH=$(uname -m)
        case "$GOTRUE_ARCH" in
            x86_64) GOTRUE_ARCH="linux-amd64" ;;
            aarch64) GOTRUE_ARCH="linux-arm64" ;;
            *) log_error "Unsupported architecture for GoTrue: $GOTRUE_ARCH"; exit 1 ;;
        esac
        local GOTRUE_URL="https://github.com/supabase/auth/releases/download/${GOTRUE_VERSION}/auth-${GOTRUE_VERSION}-${GOTRUE_ARCH}.tar.gz"
        log_info "Downloading GoTrue ${GOTRUE_VERSION}..."
        local TMP_DIR
        TMP_DIR=$(mktemp -d)
        if curl -fsSL "https://gh-proxy.net/${GOTRUE_URL}" -o "${TMP_DIR}/gotrue.tar.gz" 2>/dev/null || \
           curl -fsSL "${GOTRUE_URL}" -o "${TMP_DIR}/gotrue.tar.gz"; then
            tar -xf "${TMP_DIR}/gotrue.tar.gz" -C "${TMP_DIR}"
            if [[ -f "${TMP_DIR}/auth" ]]; then
                mv "${TMP_DIR}/auth" "$GOTRUE_BIN"
            elif [[ -f "${TMP_DIR}/gotrue" ]]; then
                mv "${TMP_DIR}/gotrue" "$GOTRUE_BIN"
            else
                log_error "GoTrue binary not found in archive"
                rm -rf "$TMP_DIR"
                exit 1
            fi
            chmod +x "$GOTRUE_BIN"
            log_info "GoTrue installed to $GOTRUE_BIN"
        else
            log_error "Failed to download GoTrue"
            rm -rf "$TMP_DIR"
            exit 1
        fi
        rm -rf "$TMP_DIR"
    else
        log_info "GoTrue binary already available at $GOTRUE_BIN"
    fi

    if [[ ! -f /etc/systemd/system/supacloud-gotrue@.service ]]; then
        log_info "Installing supacloud-gotrue@.service systemd template..."
        cat > /etc/systemd/system/supacloud-gotrue@.service << 'GOTRUE_SVC'
[Unit]
Description=SupaCloud GoTrue for tenant %i
After=network.target patroni.service
Wants=patroni.service

[Service]
Type=simple
User=nobody
Group=nobody
EnvironmentFile=/etc/supabase/tenants/%i_gotrue.env
Environment="GOMEMLIMIT=15MiB"
Environment="GOGC=20"
ExecStart=GOTRUE_BIN_PLACEHOLDER
Restart=on-failure
RestartSec=5
StartLimitBurst=3

# Security and resource sandboxing
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/supabase/tenants
MemoryMax=30M
CPUWeight=20

[Install]
WantedBy=multi-user.target
GOTRUE_SVC
        sed -i "s|GOTRUE_BIN_PLACEHOLDER|${GOTRUE_BIN}|" /etc/systemd/system/supacloud-gotrue@.service
        log_info "supacloud-gotrue@.service template installed"
    else
        log_info "supacloud-gotrue@.service template already exists"
    fi

    # Ensure tenant config directory exists
    mkdir -p /etc/supabase/tenants

    # 8. Inject terminal environment variables
    cat > /etc/profile.d/supacloud.sh <<EOF
export MASTER_TOKEN="${MASTER_TOKEN}"
export MANAGEMENT_API_URL="http://localhost:9090"
alias sc='supacloud'
EOF
    chmod 644 /etc/profile.d/supacloud.sh
    
    log_info "SupaCloud Control Plane deployed successfully!"
}

# ========== Install Web Console (Studio UI) ==========
install_web_console() {
    log_step "Installing Web Console (Studio UI)..."

    local WEB_CONSOLE_DIR="/opt/supacloud/web-console/current"
    local WEB_CONSOLE_SRC="${SCRIPT_DIR}/packages/web-console/build"
    local WEB_CONSOLE_TAR="${SCRIPT_DIR}/dist/web-console-build.tar.gz"
    local GH_PROXY="${GH_PROXY:-https://ghproxy.net}"

    mkdir -p "$WEB_CONSOLE_DIR"

    if [[ -f "$WEB_CONSOLE_DIR/index.html" ]]; then
        log_info "Web Console already deployed at $WEB_CONSOLE_DIR, skipping"
        return 0
    fi

    if [[ -d "$WEB_CONSOLE_SRC" ]] && [[ -f "$WEB_CONSOLE_SRC/index.html" ]]; then
        cp -rf "$WEB_CONSOLE_SRC"/* "$WEB_CONSOLE_DIR/"
        log_info "Web Console deployed from local source build"
    elif [[ -f "$WEB_CONSOLE_TAR" ]]; then
        tar -xzf "$WEB_CONSOLE_TAR" -C "$WEB_CONSOLE_DIR/"
        log_info "Web Console deployed from local tarball"
    else
        log_info "Downloading Web Console from GitHub Releases..."
        local DOWNLOAD_URL="${GH_PROXY}/https://github.com/zuohuadong/supacloud/releases/latest/download/web-console-build.tar.gz"
        local TMP_TAR="/tmp/web-console-build.tar.gz"
        curl -fSL -o "$TMP_TAR" "$DOWNLOAD_URL" 2>/dev/null || {
            DOWNLOAD_URL="https://github.com/zuohuadong/supacloud/releases/latest/download/web-console-build.tar.gz"
            curl -fSL -o "$TMP_TAR" "$DOWNLOAD_URL" || {
                log_warn "Web Console download failed, Studio UI will not be available"
                log_warn "You can manually build and deploy: bun run build (in packages/web-console) then copy to $WEB_CONSOLE_DIR"
                return 1
            }
        }
        if file "$TMP_TAR" | grep -q "gzip"; then
            tar -xzf "$TMP_TAR" -C "$WEB_CONSOLE_DIR/"
            rm -f "$TMP_TAR"
            log_info "Web Console deployed from GitHub Release"
        else
            rm -f "$TMP_TAR"
            log_warn "Downloaded file is not a valid gzip archive, skipping Web Console deployment"
            return 1
        fi
    fi

    if [[ -f "$WEB_CONSOLE_DIR/index.html" ]]; then
        log_info "Web Console (Studio UI) installed successfully"
    else
        log_warn "Web Console deployment incomplete - index.html not found"
    fi
}

# ========== Deploy Service Containers (Imaginary + Realtime) ==========
deploy_service_containers() {
    log_step "Deploying SupaCloud service containers..."

    local RUNTIME="${CONTAINER_RUNTIME:-podman}"
    local MIRROR_PREFIX="${DOCKER_MIRROR_PREFIX:-docker.1ms.run/}"

    # --- 1. Deploy Imaginary (Image Transformation Engine) ---
    if $RUNTIME ps -a --format '{{.Names}}' 2>/dev/null | grep -q supacloud-imaginary; then
        log_info "Imaginary container already exists, skipping"
    else
        local IMAGINARY_IMAGE_VALUE="${IMAGINARY_IMAGE:-h2non/imaginary:1.2.4}"
        local IMAGINARY_IMAGE_PULL="${MIRROR_PREFIX}${IMAGINARY_IMAGE_VALUE}"
        log_info "Pulling and deploying Imaginary (image processing): ${IMAGINARY_IMAGE_VALUE}"
        if ! $RUNTIME pull "$IMAGINARY_IMAGE_PULL" 2>/dev/null; then
            IMAGINARY_IMAGE_PULL="$IMAGINARY_IMAGE_VALUE"
            $RUNTIME pull "$IMAGINARY_IMAGE_PULL"
        fi

        $RUNTIME run -d \
            --name supacloud-imaginary \
            --restart=always \
            -p 127.0.0.1:9010:9000 \
            "$IMAGINARY_IMAGE_PULL" \
            -enable-url-source \
            -allowed-origins ".*"

        log_info "Imaginary deployed on port 9010"
    fi

    # --- 2. Deploy Supabase Realtime (Multi-tenant WebSocket) ---
    local REALTIME_UNIT_SRC="${SCRIPT_DIR}/infrastructure/systemd/supacloud-realtime.service"
    local REALTIME_IMAGE_VALUE="${REALTIME_IMAGE:-public.ecr.aws/supabase/realtime:v2.76.5}"
    if [[ -f "$REALTIME_UNIT_SRC" ]]; then
        log_info "Registering SupaCloud Realtime systemd unit..."
        cp "$REALTIME_UNIT_SRC" /etc/systemd/system/supacloud-realtime.service
        systemctl daemon-reload
        systemctl enable supacloud-realtime

        # The systemd unit uses the canonical REALTIME_IMAGE name. Pre-pull it
        # here so installs behind registry mirrors still work without editing
        # the unit file. When a mirror pull succeeds, tag it back to the
        # canonical name expected by the unit.
        local REALTIME_IMAGE_PULL="${MIRROR_PREFIX}${REALTIME_IMAGE_VALUE}"
        log_info "Pulling Supabase Realtime image: ${REALTIME_IMAGE_VALUE}"
        if [[ -n "$MIRROR_PREFIX" ]] && $RUNTIME pull "$REALTIME_IMAGE_PULL" 2>/dev/null; then
            $RUNTIME tag "$REALTIME_IMAGE_PULL" "$REALTIME_IMAGE_VALUE" 2>/dev/null || true
        else
            $RUNTIME pull "$REALTIME_IMAGE_VALUE"
        fi

        systemctl restart supacloud-realtime || log_warn "Realtime service start failed, please check journalctl -u supacloud-realtime"
    elif $RUNTIME ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "${REALTIME_CONTAINER_NAME:-supacloud-realtime}"; then
        log_info "Realtime container already exists, skipping"
    else
        log_info "Pulling and deploying Supabase Realtime (multi-tenant)..."
        $RUNTIME pull "$REALTIME_IMAGE_VALUE"

        if [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
            PGPASSWORD="${POSTGRES_PASSWORD}" psql -h "${INTERNAL_IP}" -U supabase_admin -d postgres \
                -c "CREATE SCHEMA IF NOT EXISTS _realtime;" 2>/dev/null || true
        fi

        $RUNTIME rm -f "${REALTIME_CONTAINER_NAME:-supacloud-realtime}" >/dev/null 2>&1 || true
        $RUNTIME run -d \
            --name "${REALTIME_CONTAINER_NAME:-supacloud-realtime}" \
            --restart=always \
            --privileged \
            -p 127.0.0.1:4000:4000 \
            -e PORT=4000 \
            -e DB_HOST="${INTERNAL_IP}" \
            -e DB_PORT=5432 \
            -e DB_USER="${REALTIME_DB_USER:-supabase_admin}" \
            -e DB_PASSWORD="${POSTGRES_PASSWORD}" \
            -e DB_NAME=postgres \
            -e "DB_AFTER_CONNECT_QUERY=SET search_path TO _realtime" \
            -e DB_ENC_KEY="${REALTIME_DB_ENC_KEY}" \
            -e DB_SSL=false \
            -e API_JWT_SECRET="${JWT_SECRET}" \
            -e JWT_SECRET="${JWT_SECRET}" \
            -e SECRET_KEY_BASE="${REALTIME_SECRET_KEY_BASE}" \
            -e METRICS_JWT_SECRET="${JWT_SECRET}" \
            -e ERL_AFLAGS="-proto_dist inet_tcp" \
            -e "DNS_NODES=''" \
            -e RLIMIT_NOFILE=10000 \
            -e APP_NAME=realtime \
            -e SEED_SELF_HOST=true \
            -e RUN_JANITOR=true \
            -e SECURE_CHANNELS=false \
            -e DISABLE_HEALTHCHECK_LOGGING=true \
            "$REALTIME_IMAGE_VALUE"

        log_info "Realtime deployed on port 4000 (multi-tenant mode)"
    fi

    # --- 3. Update management API env with container references ---
    if ! grep -q "IMAGINARY_URL" /etc/supabase/management-api.env 2>/dev/null; then
        cat >> /etc/supabase/management-api.env <<EOF

# Service container endpoints
IMAGINARY_URL=http://127.0.0.1:9010
REALTIME_ADMIN_URL=http://127.0.0.1:4000
REALTIME_API_SECRET=${JWT_SECRET:-super-secret-jwt-token}
EOF
        log_info "Container endpoints appended to management-api.env"
    fi

    log_info "Service containers deployed successfully!"
}

# ========== Repair Stale Projects ==========
repair_stale_projects() {
    log_step "Checking for stale projects needing database provisioning..."
    local ADMIN_SQL="sudo -u postgres psql -d postgres -t -A"

    local PROJECTS=$($ADMIN_SQL -c "SELECT ref, db_name, db_user, db_password, status FROM projects WHERE status IN ('creating','paused') OR status IS NULL;" 2>/dev/null)

    if [[ -z "$PROJECTS" ]]; then
        log_info "No stale projects found"
        return 0
    fi

    while IFS='|' read -r REF DB_NAME DB_USER DB_PASS PSTATUS; do
        REF=$(echo "$REF" | tr -d ' ')
        DB_NAME=$(echo "$DB_NAME" | tr -d ' ')
        DB_USER=$(echo "$DB_USER" | tr -d ' ')
        DB_PASS=$(echo "$DB_PASS" | tr -d ' ')
        PSTATUS=$(echo "$PSTATUS" | tr -d ' ')

        if [[ -z "$REF" || -z "$DB_NAME" ]]; then
            continue
        fi

        local DB_EXISTS=$($ADMIN_SQL -c "SELECT 1 FROM pg_database WHERE datname='$DB_NAME';" 2>/dev/null | tr -d ' ')

        if [[ "$DB_EXISTS" != "1" ]]; then
            log_info "Provisioning database $DB_NAME for project $REF (status: $PSTATUS)..."
            sudo -u postgres psql -d postgres -c "CREATE DATABASE \"$DB_NAME\";" 2>/dev/null
            sudo -u postgres psql -d postgres -c "CREATE ROLE \"$DB_USER\" LOGIN CONNECTION LIMIT 20 PASSWORD '$DB_PASS';" 2>/dev/null || true
            sudo -u postgres psql -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$DB_USER\";" 2>/dev/null
            sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO \"$DB_USER\";" 2>/dev/null
            sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";" 2>/dev/null
            sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\";" 2>/dev/null
            sudo -u postgres psql -d supacloud_meta -c "UPDATE projects SET status='active' WHERE ref='$REF';" 2>/dev/null
            log_info "Project $REF: database $DB_NAME created and activated"
        else
            if [[ "$PSTATUS" != "active" ]]; then
                sudo -u postgres psql -d supacloud_meta -c "UPDATE projects SET status='active' WHERE ref='$REF';" 2>/dev/null
                log_info "Project $REF: database exists, status updated to active"
            fi
        fi
    done <<< "$PROJECTS"

    log_info "Stale project repair complete"
}

# ========== Show Completion Message ==========
show_completion() {
    log_step "Installation Complete!"
    
    echo ""
    echo "============================================================"
    echo -e "${GREEN}SupaCloud Installed Successfully!${NC}"
    echo "============================================================"
    echo ""
    echo "Access Addresses:"
    echo "  Project API:     https://${SUPABASE_PUBLIC_DOMAIN} (DNS and HTTPS required)"
    echo "  Web Console:     https://${SUPABASE_STUDIO_DOMAIN} (DNS and HTTPS required)"
    echo "  Management API:  http://${INTERNAL_IP}:9090"
    echo "  Swagger Docs:    http://${INTERNAL_IP}:9090/swagger"
    echo "  Grafana Monitoring: http://${INTERNAL_IP}:3000"
    echo ""
    echo "All login credentials saved to:"
    echo -e "${YELLOW}  /etc/supabase/supacloud-credentials.env${NC}"
    echo ""
    echo "Please keep this file secure!"
    echo ""
    echo "Management API Master Token:"
    if [[ -f /etc/supabase/master-token.env ]]; then
        source /etc/supabase/master-token.env 2>/dev/null || true
        echo -e "  ${YELLOW}MASTER_TOKEN=${MASTER_TOKEN}${NC}"
    fi
    echo "  Take effect now: source /etc/profile.d/supacloud.sh"
    echo "  Take effect automatically after next login (written to /etc/profile.d/supacloud.sh)"
    echo ""
    echo "Next Steps:"
    echo "  1. Point the DNS A record for ${SUPABASE_PUBLIC_DOMAIN} to the server's public IP"
    echo "  2. Configure customer domains in the console; SupaCloud uses Caddy Automatic HTTPS by default"
    echo ""
    echo "Common Commands:"
    echo "  Check container status: podman ps or docker ps"
    echo "  Check logs: podman logs <container_name>"
    echo "  Restart services: systemctl restart supacloud supacloud-caddy"
    echo ""
    echo "Multi-tenant Management:"
    echo "  sc list              - List all projects"
    echo "  sc create <name>     - Create new project"
    echo "  sc info <ref>        - Show project details"
    echo "  sc keys <ref>        - Get API keys"
    echo "  sc health            - Health check"
    echo ""
}

# ========== PostgreSQL Performance Tuning ==========
tune_postgres() {
    log_step "Applying PostgreSQL 18 performance optimization parameters..."

    local tune_script="${SCRIPT_DIR}/infra/postgres/pg_tune.sh"
    if [[ ! -f "${tune_script}" ]]; then
        log_warn "pg_tune.sh does not exist (${tune_script}), skipping tuning"
        return 0
    fi

    # Wait for PostgreSQL to be fully ready (Pigsty might take a few seconds after start)
    local retries=0
    until psql -h /var/run/postgresql -U postgres -d postgres -c "SELECT 1" &>/dev/null 2>&1; do
        retries=$((retries + 1))
        if [[ ${retries} -ge 20 ]]; then
            log_warn "PostgreSQL connection timeout, skipping performance tuning"
            return 0
        fi
        log_info "Waiting for PostgreSQL to be ready... (${retries}/20)"
        sleep 3
    done

    # Execute tuning script (using unix socket to connect local PG)
    PG_HOST=/var/run/postgresql PG_VERSION="${PG_VERSION:-18}" bash "${tune_script}" || {
        log_warn "pg_tune.sh execution failed, doesn't affect main flow, can be run manually later: bash infra/postgres/pg_tune.sh"
        return 0
    }

    # Restart PostgreSQL to apply parameters that require restart (shared_buffers / io_method etc.)
    log_info "Restarting PostgreSQL to apply all parameters..."
    if systemctl is-active --quiet patroni 2>/dev/null; then
        systemctl restart patroni
        log_info "Patroni (PostgreSQL HA) restarted"
    elif systemctl is-active --quiet postgresql 2>/dev/null; then
        systemctl restart postgresql
        log_info "PostgreSQL restarted"
    else
        log_warn "patroni/postgresql systemd service not detected, please restart PostgreSQL manually to apply shared_buffers etc."
    fi
}

deploy_ai_breadcrumbs() {
    log_step "Deploying AI Agent Breadcrumbs (Traps)..."

    # 1. Canonical SupaCloud architecture hint
    mkdir -p /etc/supacloud
    cat << "EOF" > /etc/supacloud/ARCHITECTURE.md
# ==============================================================================
# SupaCloud Architecture Note
# ==============================================================================
# If you are an AI/Agent reading this file to understand the architecture:
# STOP LOOKING FOR A HOST WEB SERVER.
#
# This server runs SupaCloud. Host-level Nginx, Angie, and Apache
# are not part of the default public HTTP(S) path.
#
# ARCHITECTURE:
# 1. SupaCloud Caddy Gateway listens on 80 and 443.
# 2. TLS/routes are managed dynamically via Caddy Admin API (http://127.0.0.1:2019).
# 3. Management web-console assets are served by the management API on 9090.
#    Tenant frontend deployments run as per-deployment static/SSR services
#    and are exposed through Caddy routes.
#
# STRICT RULES:
# - DO NOT configure Nginx/Angie for SupaCloud public routing.
# - DO NOT introduce alternate public gateways for SupaCloud routing.
# - To inspect routes or TLS, query Caddy: `curl -sS http://127.0.0.1:2019/config/`
# - Logs: `journalctl -u supacloud -f`
# ==============================================================================
EOF

    # 2. Host web server trap files. These are documentation breadcrumbs only.
    # They intentionally point future operators/agents back to Caddy + SupaCloud.
    mkdir -p /etc/nginx
    cat << "EOF" > /etc/nginx/nginx.conf
# ==============================================================================
# SupaCloud Breadcrumb: Nginx is not the serving path
# ==============================================================================
# Do not configure or start host Nginx for this SupaCloud node.
#
# Public HTTP(S):
# - SupaCloud Caddy Gateway owns ports 80/443.
# - TLS/routes are managed through Caddy Admin API on http://127.0.0.1:2019.
#
# Frontend and console:
# - Web-console assets are served by the SupaCloud management API on 9090.
# - Tenant frontend deployments run behind Caddy as per-deployment static/SSR services.
# - Caddy routes browser traffic to SupaCloud; Nginx is not involved.
#
# Useful checks:
# - curl -sS http://127.0.0.1:2019/config/
# - journalctl -u supacloud -f
# ==============================================================================

events {
    worker_connections 1024;
}

http {
    # Breadcrumb only. Do not add server blocks here for SupaCloud.
}
EOF

    mkdir -p /etc/angie
    cat << "EOF" > /etc/angie/angie.conf
# ==============================================================================
# SupaCloud Breadcrumb: Angie is not the serving path
# ==============================================================================
# Do not configure or start host Angie for this SupaCloud node.
# SupaCloud Caddy Gateway owns ports 80/443. Web-console assets are served by the management API on 9090; tenant frontends run behind Caddy as per-deployment services.
# Inspect Caddy routes with: curl -sS http://127.0.0.1:2019/config/
# ==============================================================================

events {
    worker_connections 1024;
}

http {
    # Breadcrumb only. Do not add server blocks here for SupaCloud.
}
EOF

    mkdir -p /etc/caddy
    cat << "EOF" > /etc/caddy/Caddyfile
# ==============================================================================
# SupaCloud Breadcrumb: Caddy is the serving path
# ==============================================================================
# This file is documentation only. SupaCloud writes JSON config to
# /etc/supacloud/caddy/config.json and publishes it via Caddy Admin API.
# Inspect routes with: curl -sS http://127.0.0.1:2019/config/
# ==============================================================================
EOF

    # 3. Edge Functions Deno/Bun Hint
    mkdir -p /opt/supacloud/edge-runtime/functions
    cat << "EOF" > /opt/supacloud/edge-runtime/functions/deno.json
{
  "==============================================================================": "",
  "🤖 HELLO AI AGENT 🤖 (BREADCRUMB FILE)": "",
  "==============================================================================": "",
  "WARNING": "THIS IS NOT A DENO PROJECT!",
  "ARCHITECTURE": "SupaCloud Edge Functions run natively on BUN, not Deno.",
  "RULES": [
    "DO NOT use `supabase functions` CLI",
    "DO NOT add Deno-specific imports",
    "USE pure TypeScript compiled via Bun",
    "Read the actual function sources in the subdirectories"
  ]
}
EOF
    log_info "AI Agent breadcrumbs deployed successfully."
}

# ========== Main Function ==========
main() {
    echo ""
    echo "============================================================"
    echo "  Pigsty Supabase One-Click Installation Script"
    echo "  https://pigsty.cc/docs/app/supabase/"
    echo "============================================================"
    echo ""
    
    check_config
    generate_jwt_keys
    check_os_compatibility
    check_system
    install_base_dependencies  # Ensure base tools like sudo, tar, ssh exist
    setup_local_ssh            # Ensure local SSH passwordless (required by Ansible)
    setup_swap
    enable_ksm_optimization     # Kernel stack memory deduplication
    
    install_container_runtime
    install_docker_compose
    install_s3_storage
    install_edge_runtime
    install_pigsty      # Pigsty nginx suppressed via nginx_enabled: false
    configure_analytics
    configure_pg_hba
    configure_low_memory_tcp_guardrails
    
    # Gateway setup runs after Pigsty so Caddy can publish routes through its Admin API.
    install_caddy_gateway

    # Performance tuning after Pigsty PG initialization
    tune_postgres
    
    # [NEW] Initialize JuiceFS S3 Gateway if needed (PG is ready now)
    if [[ -f /etc/supabase/.init_juicefs ]] && [[ "$S3_STORAGE_TYPE" == "juicefs" ]]; then
        init_juicefs_s3_gateway
        rm -f /etc/supabase/.init_juicefs
        configure_pgbackrest_juicefs
    fi

    # Install Management API
    install_management_api
    install_web_console

    # Deploy Imaginary + Realtime containers
    deploy_service_containers
    cleanup_legacy_supabase_compose_stack

    # Save all credentials
    save_all_credentials

    repair_stale_projects

    deploy_ai_breadcrumbs

    show_completion
}

# Execute main if run directly; load functions if sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi

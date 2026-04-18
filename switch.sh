#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

show_help() {
    echo "SupaCloud Configuration Tool"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  runtime <embedded|external>  Switch Edge Runtime mode"
    echo "  storage <type>               Switch S3 storage type"
    echo "  status                       Show current configuration"
    echo ""
    echo "Runtime Modes:"
    echo "  embedded                     Edge Runtime managed by supacloud.service"
    echo "  external                     Edge Runtime managed by supacloud-edge-runtime.service"
    echo ""
    echo "Storage Types:"
    echo "  juicefs                      Use JuiceFS S3 Gateway (default)"
    echo "  minio                        Use MinIO (Pigsty built-in)"
    echo "  garage                       Use Garage S3"
    echo "  rustfs                       Use RustFS"
    echo "  external                     Use external S3 (requires additional config)"
    echo ""
    echo "Examples:"
    echo "  $0 runtime embedded          Use embedded Edge Runtime"
    echo "  $0 runtime external          Use standalone Edge Runtime service"
    echo "  $0 storage garage            Switch to Garage S3"
    echo "  $0 status                    Show current status"
    echo ""
}

management_env_file() {
    echo "/etc/supabase/management-api.env"
}

current_runtime_mode() {
    local env_file
    env_file="$(management_env_file)"
    if [[ -f "$env_file" ]]; then
        local mode
        mode=$(grep -E '^EDGE_RUNTIME_MODE=' "$env_file" 2>/dev/null | tail -n 1 | cut -d'=' -f2- || true)
        mode="${mode//\"/}"
        if [[ -n "$mode" ]]; then
            echo "$mode"
            return
        fi
    fi
    echo "embedded"
}

set_runtime_mode_in_env() {
    local mode="$1"
    local env_file
    env_file="$(management_env_file)"
    mkdir -p "$(dirname "$env_file")"
    touch "$env_file"
    if grep -q '^EDGE_RUNTIME_MODE=' "$env_file" 2>/dev/null; then
        python3 - <<'PY' "$env_file" "$mode"
from pathlib import Path
import sys
path = Path(sys.argv[1])
mode = sys.argv[2]
text = path.read_text() if path.exists() else ""
lines = text.splitlines()
updated = False
for i, line in enumerate(lines):
    if line.startswith('EDGE_RUNTIME_MODE='):
        lines[i] = f'EDGE_RUNTIME_MODE={mode}'
        updated = True
        break
if not updated:
    lines.append(f'EDGE_RUNTIME_MODE={mode}')
path.write_text('\n'.join(lines) + ('\n' if lines else ''))
PY
    else
        printf '\nEDGE_RUNTIME_MODE=%s\n' "$mode" >> "$env_file"
    fi
}

show_status() {
    log_step "Current configuration status"
    echo ""

    local runtime_mode
    runtime_mode="$(current_runtime_mode)"
    echo "Edge Functions Runtime:"
    echo -e "  Runtime: ${GREEN}Bun + Elysia Worker Pool${NC}"
    echo "  Mode: ${runtime_mode}"
    if [[ "$runtime_mode" == "external" ]]; then
        if systemctl is-active --quiet supacloud-edge-runtime 2>/dev/null; then
            echo -e "  Status:  ${GREEN}Running${NC}"
        else
            echo -e "  Status:  ${RED}Stopped${NC}"
        fi
        echo "  Service: supacloud-edge-runtime.service"
    else
        echo -e "  Status:  ${GREEN}Managed by supacloud.service${NC}"
        echo "  Service: embedded in supacloud.service"
    fi
    echo "  Port: 9000"
    echo ""

    echo "S3 Storage:"
    if systemctl is-active --quiet garage 2>/dev/null; then
        echo -e "  Current: ${GREEN}Garage${NC}"
        echo "  Port: 9000"
    elif systemctl is-active --quiet rustfs 2>/dev/null; then
        echo -e "  Current: ${GREEN}RustFS${NC}"
        echo "  Port: 9000"
    elif systemctl is-active --quiet minio 2>/dev/null; then
        echo -e "  Current: ${GREEN}MinIO${NC}"
    else
        echo "  Current: External S3 or not configured"
    fi
    echo ""

    echo "Service Containers:"
    local crt="podman"
    command -v podman &>/dev/null || crt="docker"
    local rt_status im_status
    rt_status=$($crt ps -a --filter "name=supabase-realtime" --format "{{.Status}}" 2>/dev/null || echo "Not deployed")
    im_status=$($crt ps -a --filter "name=supacloud-imaginary" --format "{{.Status}}" 2>/dev/null || echo "Not deployed")
    echo "  Realtime:  ${rt_status:-Not deployed}"
    echo "  Imaginary: ${im_status:-Not deployed}"
    echo ""

    echo "Config file locations:"
    echo "  Management API: /etc/supabase/management-api.env"
    echo "  JWT Keys: /etc/supabase/jwt-keys.env"
    [[ -f /etc/garage/s3-credentials.env ]] && echo "  Garage Credentials: /etc/garage/s3-credentials.env"
    [[ -f /etc/rustfs-credentials.env ]] && echo "  RustFS Credentials: /etc/rustfs-credentials.env"
    echo ""
}

switch_runtime() {
    local runtime_mode="$1"
    case "$runtime_mode" in
        embedded|external)
            ;;
        *)
            log_error "Unknown runtime mode: $runtime_mode"
            log_info "Supported modes: embedded, external"
            exit 1
            ;;
    esac

    log_step "Switching Edge Runtime mode to ${runtime_mode}..."
    set_runtime_mode_in_env "$runtime_mode"
    systemctl daemon-reload

    if [[ "$runtime_mode" == "external" ]]; then
        systemctl enable supacloud-edge-runtime 2>/dev/null || true
        systemctl restart supacloud-edge-runtime 2>/dev/null || systemctl start supacloud-edge-runtime 2>/dev/null || true
        log_info "Edge Runtime switched to external mode"
        log_info "Standalone service: supacloud-edge-runtime.service"
    else
        systemctl disable --now supacloud-edge-runtime 2>/dev/null || true
        log_info "Edge Runtime switched to embedded mode"
        log_info "Managed by supacloud.service"
    fi

    systemctl restart supacloud.service 2>/dev/null || true
}

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
            log_error "Unknown storage type: $storage_type"
            log_info "Supported types: minio, garage, rustfs, external"
            exit 1
            ;;
    esac
}

switch_to_juicefs() {
    log_step "Switching to JuiceFS S3 Gateway..."
    systemctl stop garage 2>/dev/null || true
    systemctl stop rustfs 2>/dev/null || true

    if ! command -v juicefs &> /dev/null; then
        log_warn "JuiceFS not installed"
        log_info "Please run: S3_STORAGE_TYPE=juicefs ./install.sh"
        exit 1
    fi

    systemctl enable --now juicefs-s3 2>/dev/null || systemctl restart juicefs-s3 2>/dev/null || true

    INTERNAL_IP=$(hostname -I | awk '{print $1}')
    update_supabase_s3_config "juicefs" "http://${INTERNAL_IP}:9000" "us-east-1"

    log_info "Switched to JuiceFS S3 Gateway"
    log_info "S3 Endpoint: http://${INTERNAL_IP}:9000"
}

switch_to_minio() {
    log_step "Switching to MinIO..."
    systemctl stop garage 2>/dev/null || true
    systemctl stop rustfs 2>/dev/null || true
    log_info "MinIO is managed by Pigsty"
    log_info "Please ensure Pigsty MinIO service is running"
    log_info "Run: cd ~/pigsty && ./minio.yml"
    log_info "Switched to MinIO"
}

switch_to_garage() {
    log_step "Switching to Garage S3..."
    systemctl stop rustfs 2>/dev/null || true

    log_info "Checking MinIO container..."
    if command -v docker &> /dev/null; then
        docker stop minio 2>/dev/null || true
        docker rm minio 2>/dev/null || true
    elif command -v podman &> /dev/null; then
        podman stop minio 2>/dev/null || true
        podman rm minio 2>/dev/null || true
    fi

    if ! command -v garage &> /dev/null; then
        log_warn "Garage not installed, installing..."
        log_info "Please run: S3_STORAGE_TYPE=garage ./install.sh"
        exit 1
    fi

    systemctl enable --now garage
    systemctl restart garage

    log_info "Waiting for Garage to start..."
    sleep 5
    if ! systemctl is-active --quiet garage; then
        log_error "Garage failed to start, check logs: journalctl -u garage -n 20"
        exit 1
    fi

    INTERNAL_IP=$(hostname -I | awk '{print $1}')
    update_supabase_s3_config "garage" "http://${INTERNAL_IP}:9000" "garage"

    log_info "Switched to Garage S3"
    log_info "S3 Endpoint: http://${INTERNAL_IP}:9000"
    log_info "Credentials: /etc/garage/s3-credentials.env"
}

switch_to_rustfs() {
    log_step "Switching to RustFS..."
    systemctl stop garage 2>/dev/null || true

    if ! command -v rustfs &> /dev/null; then
        log_warn "RustFS not installed, installing..."
        log_info "Please run: S3_STORAGE_TYPE=rustfs ./install.sh"
        exit 1
    fi

    systemctl enable --now rustfs

    if [[ -f /etc/rustfs-credentials.env ]]; then
        source /etc/rustfs-credentials.env
        update_supabase_s3_config "rustfs" "$S3_ENDPOINT" "$S3_REGION"
    fi

    log_info "Switched to RustFS"
    log_info "S3 Endpoint: http://localhost:9000"
    log_info "Credentials: /etc/rustfs-credentials.env"
}

configure_external_s3() {
    log_step "Configuring external S3..."

    echo ""
    echo "Please enter external S3 configuration:"
    read -r -p "S3 Endpoint URL: " S3_ENDPOINT
    read -r -p "S3 Region: " S3_REGION
    read -r -p "Access Key: " S3_ACCESS_KEY
    read -r -s -p "Secret Key: " S3_SECRET_KEY
    echo ""
    read -r -p "Bucket Name: " S3_BUCKET

    cat > /etc/supabase/external-s3.env << EOF
# External S3 Configuration
S3_ENDPOINT=${S3_ENDPOINT}
S3_REGION=${S3_REGION}
S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}
S3_BUCKET=${S3_BUCKET}
EOF
    chmod 600 /etc/supabase/external-s3.env

    systemctl stop garage 2>/dev/null || true
    systemctl stop rustfs 2>/dev/null || true

    update_supabase_s3_config "external" "$S3_ENDPOINT" "$S3_REGION"

    log_info "External S3 configured"
    log_info "Configuration saved to: /etc/supabase/external-s3.env"
}

update_supabase_s3_config() {
    local type=$1
    local endpoint=$2
    local region=$3

    SUPABASE_ENV=~/pigsty/app/supabase/.env

    if [[ -f "$SUPABASE_ENV" ]]; then
        log_info "Updating Supabase S3 configuration..."

        sed -i "s|S3_ENDPOINT=.*|S3_ENDPOINT=${endpoint}|g" "$SUPABASE_ENV"
        sed -i "s|S3_REGION=.*|S3_REGION=${region}|g" "$SUPABASE_ENV"

        systemctl restart supacloud.service 2>/dev/null || true

        log_info "SupaCloud Management API restarted with new S3 config"
    else
        log_warn "Supabase configuration file not found: $SUPABASE_ENV"
    fi
}

main() {
    if [[ $# -eq 0 ]]; then
        show_help
        exit 0
    fi

    case "$1" in
        runtime)
            if [[ -z "${2:-}" ]]; then
                log_error "Please specify runtime mode: embedded, external"
                exit 1
            fi
            switch_runtime "$2"
            ;;
        storage)
            if [[ -z "${2:-}" ]]; then
                log_error "Please specify storage type: minio, garage, rustfs, external"
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
            log_error "Unknown command: $1"
            show_help
            exit 1
            ;;
    esac
}

main "$@"

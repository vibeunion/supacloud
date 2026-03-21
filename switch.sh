#!/bin/bash
# ============================================================
# Supabase Runtime Switch Script
# Used to switch Edge Functions runtime and S3 storage after deployment
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

# Show help
show_help() {
    echo "Supabase Runtime Switch Tool"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  runtime <deno|bun>     Switch Edge Functions runtime"
    echo "  storage <type>         Switch S3 storage type"
    echo "  status                 Show current configuration"
    echo ""
    echo "Storage Types:"
    echo "  minio                  Use MinIO (Pigsty default)"
    echo "  garage                 Use Garage S3"
    echo "  rustfs                 Use RustFS"
    echo "  external               Use external S3 (requires additional config)"
    echo ""
    echo "Examples:"
    echo "  $0 runtime bun         Switch to Bun runtime"
    echo "  $0 runtime deno        Switch to Deno runtime"
    echo "  $0 storage garage      Switch to Garage S3"
    echo "  $0 status              Show current status"
    echo ""
}

# Show current status
show_status() {
    log_step "Current configuration status"
    echo ""
    
    # Edge Functions runtime
    echo "Edge Functions Runtime:"
    if [[ -f /etc/supabase/.use_bun_runtime ]]; then
        echo -e "  Current: ${GREEN}Bun${NC}"
        if command -v podman &> /dev/null; then
            podman ps --filter "name=bun-functions" --format "  Container Status: {{.Status}}" 2>/dev/null || echo "  Container Status: Not running"
        elif command -v docker &> /dev/null; then
            docker ps --filter "name=bun-functions" --format "  Container Status: {{.Status}}" 2>/dev/null || echo "  Container Status: Not running"
        fi
        echo "  Config: /etc/supabase/bun-functions.env"
    else
        echo -e "  Current: ${GREEN}Deno${NC} (Official default)"
        if command -v podman &> /dev/null; then
            podman ps --filter "name=edge-functions" --format "  Container Status: {{.Status}}" 2>/dev/null || echo "  Container Status: Not running"
        fi
        [[ -f /etc/supabase/deno-functions.env ]] && echo "  Config: /etc/supabase/deno-functions.env"
    fi
    echo ""
    
    # S3 Storage
    echo "S3 Storage:"
    if [[ -f /etc/supabase/bun-functions.env ]]; then
        source /etc/supabase/bun-functions.env 2>/dev/null || true
    fi
    
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
    
    # Show credential locations
    echo "Config file locations:"
    echo "  JWT Keys: /etc/supabase/jwt-keys.env"
    [[ -f /etc/garage/s3-credentials.env ]] && echo "  Garage Credentials: /etc/garage/s3-credentials.env"
    [[ -f /etc/rustfs-credentials.env ]] && echo "  RustFS Credentials: /etc/rustfs-credentials.env"
    echo ""
}

# Switch Edge Functions runtime
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
            log_error "Unknown runtime: $runtime"
            log_info "Supported runtimes: deno, bun"
            exit 1
            ;;
    esac
}

# Switch to Deno
switch_to_deno() {
    log_step "Switching to Deno runtime..."
    
    # Stop Bun container
    if command -v podman &> /dev/null; then
        podman stop supabase-bun-functions 2>/dev/null || true
        podman rm supabase-bun-functions 2>/dev/null || true
    elif command -v docker &> /dev/null; then
        docker stop supabase-bun-functions 2>/dev/null || true
        docker rm supabase-bun-functions 2>/dev/null || true
    fi
    
    # Remove Bun flag
    rm -f /etc/supabase/.use_bun_runtime
    
    # Get IP for writing to environment
    INTERNAL_IP=$(hostname -I | awk '{print $1}')
    DENO_FUNCTIONS_DIR=~/pigsty/app/supabase/volumes/functions
    
    # Display output environment info
    cat > /etc/supabase/deno-functions.env << EOF
# Deno Edge Functions Configuration
# Runtime managed by Pigsty's docker-compose (supabase-edge-functions container) 
EDGE_FUNCTIONS_DIR="${DENO_FUNCTIONS_DIR}"
API_ENDPOINT="http://${INTERNAL_IP}:9000/functions/v1/"
EOF
    
    # Restart Supabase container to use default Deno edge-runtime
    cd ~/pigsty/app/supabase
    if command -v docker-compose &> /dev/null; then
        docker-compose up -d supabase-edge-functions
    else
        /usr/local/bin/docker-compose up -d supabase-edge-functions
    fi
    
    log_info "Switched to Deno runtime"
    log_info "Function mount point: ${DENO_FUNCTIONS_DIR}"
    log_info "Edge Functions API: http://${INTERNAL_IP}:9000/functions/v1/{function}"
}

# Switch to Bun
switch_to_bun() {
    log_step "Switching to Bun runtime..."
    
    # Check if Bun container is already built
    BUN_FUNCTIONS_DIR="/opt/supabase/bun-functions"
    
    if [[ ! -d "$BUN_FUNCTIONS_DIR" ]]; then
        log_error "Bun functions directory does not exist: $BUN_FUNCTIONS_DIR"
        log_info "Please run the installation script first and set EDGE_RUNTIME=bun"
        exit 1
    fi
    
    # Stop Deno container
    if command -v podman &> /dev/null; then
        podman stop supabase-edge-functions 2>/dev/null || true
    elif command -v docker &> /dev/null; then
        docker stop supabase-edge-functions 2>/dev/null || true
    fi
    
    # Load JWT keys
    if [[ -f /etc/supabase/jwt-keys.env ]]; then
        set -a
        source /etc/supabase/jwt-keys.env
        set +a
    fi
    
    # Start Bun container
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
    
    # Create Bun flag
    touch /etc/supabase/.use_bun_runtime
    
    log_info "Switched to Bun runtime"
    log_info "Edge Functions API: http://localhost:9001/{function}"
}

# Switch S3 storage
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

# Switch to MinIO
switch_to_minio() {
    log_step "Switching to MinIO..."
    
    # Stop other S3 services
    systemctl stop garage 2>/dev/null || true
    systemctl stop rustfs 2>/dev/null || true
    
    # MinIO is typically managed by Pigsty
    log_info "MinIO is managed by Pigsty"
    log_info "Please ensure Pigsty MinIO service is running"
    log_info "Run: cd ~/pigsty && ./minio.yml"
    
    log_info "Switched to MinIO"
}

# Switch to Garage
switch_to_garage() {
    log_step "Switching to Garage S3..."
    
    # Stop other S3 services
    systemctl stop rustfs 2>/dev/null || true
    
    # Try to stop MinIO (if exists)
    log_info "Checking MinIO container..."
    if command -v docker &> /dev/null; then
        docker stop minio 2>/dev/null || true
        docker rm minio 2>/dev/null || true
    elif command -v podman &> /dev/null; then
        podman stop minio 2>/dev/null || true
        podman rm minio 2>/dev/null || true
    fi
    
    # Check if Garage is installed
    if ! command -v garage &> /dev/null; then
        log_warn "Garage not installed, installing..."
        # You can call the installation function here, or prompt user to re-run installation script
        log_info "Please run: S3_STORAGE_TYPE=garage ./install.sh"
        exit 1
    fi
    
    # Start Garage
    systemctl enable --now garage
    systemctl restart garage
    
    # Wait for Garage startup
    log_info "Waiting for Garage to start..."
    sleep 5
    if ! systemctl is-active --quiet garage; then
        log_error "Garage failed to start, check logs: journalctl -u garage -n 20"
        exit 1
    fi
    
    # Get internal IP
    INTERNAL_IP=$(hostname -I | awk '{print $1}')
    
    # Update Supabase configuration
    update_supabase_s3_config "garage" "http://${INTERNAL_IP}:9000" "garage"
    
    log_info "Switched to Garage S3"
    log_info "S3 Endpoint: http://${INTERNAL_IP}:9000"
    log_info "Credentials: /etc/garage/s3-credentials.env"
}

# Switch to RustFS
switch_to_rustfs() {
    log_step "Switching to RustFS..."
    
    # Stop other S3 services
    systemctl stop garage 2>/dev/null || true
    
    # Check if RustFS is installed
    if ! command -v rustfs &> /dev/null; then
        log_warn "RustFS not installed, installing..."
        log_info "Please run: S3_STORAGE_TYPE=rustfs ./install.sh"
        exit 1
    fi
    
    # Start RustFS
    systemctl enable --now rustfs
    
    # Update Supabase configuration
    if [[ -f /etc/rustfs-credentials.env ]]; then
        source /etc/rustfs-credentials.env
        update_supabase_s3_config "rustfs" "$S3_ENDPOINT" "$S3_REGION"
    fi
    
    log_info "Switched to RustFS"
    log_info "S3 Endpoint: http://localhost:9000"
    log_info "Credentials: /etc/rustfs-credentials.env"
}

# Configure external S3
configure_external_s3() {
    log_step "Configuring external S3..."
    
    echo ""
    echo "Please enter external S3 configuration:"
    read -p "S3 Endpoint URL: " S3_ENDPOINT
    read -p "S3 Region: " S3_REGION
    read -p "Access Key: " S3_ACCESS_KEY
    read -sp "Secret Key: " S3_SECRET_KEY
    echo ""
    read -p "Bucket Name: " S3_BUCKET
    
    # Save configuration
    cat > /etc/supabase/external-s3.env << EOF
# External S3 Configuration
S3_ENDPOINT=${S3_ENDPOINT}
S3_REGION=${S3_REGION}
S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}
S3_BUCKET=${S3_BUCKET}
EOF
    chmod 600 /etc/supabase/external-s3.env
    
    # Stop local S3 services
    systemctl stop garage 2>/dev/null || true
    systemctl stop rustfs 2>/dev/null || true
    
    # Update Supabase configuration
    update_supabase_s3_config "external" "$S3_ENDPOINT" "$S3_REGION"
    
    log_info "External S3 configured"
    log_info "Configuration saved to: /etc/supabase/external-s3.env"
}

# Update Supabase S3 configuration
update_supabase_s3_config() {
    local type=$1
    local endpoint=$2
    local region=$3
    
    SUPABASE_ENV=~/pigsty/app/supabase/.env
    
    if [[ -f "$SUPABASE_ENV" ]]; then
        log_info "Updating Supabase S3 configuration..."
        
        sed -i "s|S3_ENDPOINT=.*|S3_ENDPOINT=${endpoint}|g" "$SUPABASE_ENV"
        sed -i "s|S3_REGION=.*|S3_REGION=${region}|g" "$SUPABASE_ENV"
        
        # SupaCloud uses its own Storage API (Bun.S3Client), restart the management API
        systemctl restart supacloud.service 2>/dev/null || true
        
        log_info "SupaCloud Management API restarted with new S3 config"
    else
        log_warn "Supabase configuration file not found: $SUPABASE_ENV"
    fi
}

# Main function
main() {
    if [[ $# -eq 0 ]]; then
        show_help
        exit 0
    fi
    
    case "$1" in
        runtime)
            if [[ -z "$2" ]]; then
                log_error "Please specify runtime: deno or bun"
                exit 1
            fi
            switch_runtime "$2"
            ;;
        storage)
            if [[ -z "$2" ]]; then
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

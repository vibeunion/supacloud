#!/bin/bash
# SupaCloud - S3 Storage Management Script
# Usage: s3_manager.sh <create|delete|credentials> <project_ref>

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"

# S3 configuration (loaded from environment variables)
S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:9000}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-}"
S3_SECRET_KEY="${S3_SECRET_KEY:-}"
S3_STORAGE_TYPE="${S3_STORAGE_TYPE:-juicefs}"

BUCKET_NAME="supa-${PROJECT_REF}"

# Load storage credentials
load_credentials() {
    case "$S3_STORAGE_TYPE" in
        juicefs)
            S3_ACCESS_KEY="${S3_ACCESS_KEY:-s3user_data}"
            S3_SECRET_KEY="${S3_SECRET_KEY:-S3User.Data}"
            ;;
        rustfs)
            if [ -f /etc/rustfs-credentials.env ]; then
                source /etc/rustfs-credentials.env
                S3_ACCESS_KEY="${RUSTFS_ROOT_USER:-$S3_ACCESS_KEY}"
                S3_SECRET_KEY="${RUSTFS_ROOT_PASSWORD:-$S3_SECRET_KEY}"
            fi
            ;;
        garage)
            if [ -f /etc/garage/s3-credentials.env ]; then
                source /etc/garage/s3-credentials.env
                S3_ACCESS_KEY="${GRG_ACCESS_KEY:-$S3_ACCESS_KEY}"
                S3_SECRET_KEY="${GRG_SECRET_KEY:-$S3_SECRET_KEY}"
            fi
            ;;
        minio)
            S3_ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}"
            S3_SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}"
            ;;
    esac
}

# Validate parameters
validate_params() {
    if [ -z "$ACTION" ] || [ -z "$PROJECT_REF" ]; then
        echo "ERROR: Missing required parameters" >&2
        echo "Usage: $0 <create|delete|credentials> <project_ref>" >&2
        exit 1
    fi

    if ! echo "$PROJECT_REF" | grep -qE '^[a-z0-9]{1,20}$'; then
        echo "ERROR: Invalid project_ref format" >&2
        exit 1
    fi
}

# Use curl for S3 operations (compatible with all S3 APIs)
s3_request() {
    local method="$1"
    local path="$2"
    local date
    date=$(date -u +"%a, %d %b %Y %H:%M:%S GMT")
    local content_type="application/octet-stream"

    # Simple signing (suitable for most S3-compatible storage)
    local string_to_sign="${method}\n\n${content_type}\n${date}\n${path}"
    local signature
    signature=$(echo -en "$string_to_sign" | openssl dgst -sha1 -hmac "$S3_SECRET_KEY" -binary | base64)

    curl -s -X "$method" \
        -H "Date: ${date}" \
        -H "Content-Type: ${content_type}" \
        -H "Authorization: AWS ${S3_ACCESS_KEY}:${signature}" \
        "${S3_ENDPOINT}${path}"
}

# Create Bucket
create_bucket() {
    echo "Creating S3 bucket: ${BUCKET_NAME}..."

    # Use mc (MinIO Client) or curl to create bucket
    if command -v mc &>/dev/null; then
        mc alias set supacloud "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" --api S3v4 2>/dev/null || true
        mc mb "supacloud/${BUCKET_NAME}" 2>/dev/null || true
    else
        s3_request "PUT" "/${BUCKET_NAME}" || true
    fi

    # Generate independent access keys for project
    local project_access_key
    local project_secret_key
    project_access_key="supa_${PROJECT_REF}_$(openssl rand -hex 8)"
    project_secret_key="$(openssl rand -hex 24)"

    echo "ACCESS_KEY=${project_access_key}"
    echo "SECRET_KEY=${project_secret_key}"
    echo "Bucket ${BUCKET_NAME} created successfully"
}

# Delete Bucket
delete_bucket() {
    echo "Deleting S3 bucket: ${BUCKET_NAME}..."

    if command -v mc &>/dev/null; then
        mc alias set supacloud "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" --api S3v4 2>/dev/null || true
        mc rb --force "supacloud/${BUCKET_NAME}" 2>/dev/null || true
    else
        # Empty bucket first
        s3_request "DELETE" "/${BUCKET_NAME}" || true
    fi

    echo "Bucket ${BUCKET_NAME} deleted successfully"
}

# Get credentials
get_credentials() {
    echo "ACCESS_KEY=${S3_ACCESS_KEY}"
    echo "SECRET_KEY=${S3_SECRET_KEY}"
    echo "ENDPOINT=${S3_ENDPOINT}"
    echo "BUCKET=${BUCKET_NAME}"
}

# Main logic
validate_params
load_credentials

case "$ACTION" in
    create)
        create_bucket
        ;;
    delete)
        delete_bucket
        ;;
    credentials)
        get_credentials
        ;;
    *)
        echo "ERROR: Unknown action '${ACTION}'. Use: create, delete, credentials" >&2
        exit 1
        ;;
esac

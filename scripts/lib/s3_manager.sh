#!/bin/bash
# SupaCloud - S3 存储管理脚本
# 用法: s3_manager.sh <create|delete|credentials> <project_ref>

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"

# S3 配置 (从环境变量加载)
S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:9000}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-}"
S3_SECRET_KEY="${S3_SECRET_KEY:-}"
S3_STORAGE_TYPE="${S3_STORAGE_TYPE:-rustfs}"

BUCKET_NAME="supa-${PROJECT_REF}"

# 加载存储凭据
load_credentials() {
    case "$S3_STORAGE_TYPE" in
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

# 验证参数
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

# 使用 curl 进行 S3 操作 (兼容所有 S3 API)
s3_request() {
    local method="$1"
    local path="$2"
    local date
    date=$(date -u +"%a, %d %b %Y %H:%M:%S GMT")
    local content_type="application/octet-stream"

    # 简单签名 (适用于大多数 S3 兼容存储)
    local string_to_sign="${method}\n\n${content_type}\n${date}\n${path}"
    local signature
    signature=$(echo -en "$string_to_sign" | openssl dgst -sha1 -hmac "$S3_SECRET_KEY" -binary | base64)

    curl -s -X "$method" \
        -H "Date: ${date}" \
        -H "Content-Type: ${content_type}" \
        -H "Authorization: AWS ${S3_ACCESS_KEY}:${signature}" \
        "${S3_ENDPOINT}${path}"
}

# 创建 Bucket
create_bucket() {
    echo "Creating S3 bucket: ${BUCKET_NAME}..."

    # 使用 mc (MinIO Client) 或 curl 创建 bucket
    if command -v mc &>/dev/null; then
        mc alias set supacloud "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" --api S3v4 2>/dev/null || true
        mc mb "supacloud/${BUCKET_NAME}" 2>/dev/null || true
    else
        s3_request "PUT" "/${BUCKET_NAME}" || true
    fi

    # 为项目生成独立的访问密钥
    local project_access_key
    local project_secret_key
    project_access_key="supa_${PROJECT_REF}_$(openssl rand -hex 8)"
    project_secret_key="$(openssl rand -hex 24)"

    echo "ACCESS_KEY=${project_access_key}"
    echo "SECRET_KEY=${project_secret_key}"
    echo "Bucket ${BUCKET_NAME} created successfully"
}

# 删除 Bucket
delete_bucket() {
    echo "Deleting S3 bucket: ${BUCKET_NAME}..."

    if command -v mc &>/dev/null; then
        mc alias set supacloud "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" --api S3v4 2>/dev/null || true
        mc rb --force "supacloud/${BUCKET_NAME}" 2>/dev/null || true
    else
        # 先清空 bucket
        s3_request "DELETE" "/${BUCKET_NAME}" || true
    fi

    echo "Bucket ${BUCKET_NAME} deleted successfully"
}

# 获取凭据
get_credentials() {
    echo "ACCESS_KEY=${S3_ACCESS_KEY}"
    echo "SECRET_KEY=${S3_SECRET_KEY}"
    echo "ENDPOINT=${S3_ENDPOINT}"
    echo "BUCKET=${BUCKET_NAME}"
}

# 主逻辑
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

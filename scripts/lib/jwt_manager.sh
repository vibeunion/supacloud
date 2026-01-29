#!/bin/bash
# SupaCloud - JWT 密钥管理脚本
# 用法: jwt_manager.sh generate <project_ref>

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"

# 验证参数
validate_params() {
    if [ -z "$ACTION" ] || [ -z "$PROJECT_REF" ]; then
        echo "ERROR: Missing required parameters" >&2
        echo "Usage: $0 generate <project_ref>" >&2
        exit 1
    fi

    if ! echo "$PROJECT_REF" | grep -qE '^[a-z0-9]{1,20}$'; then
        echo "ERROR: Invalid project_ref format" >&2
        exit 1
    fi
}

# Base64URL 编码
base64url_encode() {
    openssl enc -base64 -A | tr '+/' '-_' | tr -d '='
}

# 生成 JWT
generate_jwt() {
    local secret="$1"
    local role="$2"
    local now
    now=$(date +%s)
    local exp=$((now + 315360000)) # 10 年

    local header='{"alg":"HS256","typ":"JWT"}'
    local payload="{\"role\":\"${role}\",\"iss\":\"supabase\",\"iat\":${now},\"exp\":${exp}}"

    local encoded_header
    encoded_header=$(echo -n "$header" | base64url_encode)
    local encoded_payload
    encoded_payload=$(echo -n "$payload" | base64url_encode)

    local message="${encoded_header}.${encoded_payload}"
    local signature
    signature=$(echo -n "$message" | openssl dgst -sha256 -hmac "$secret" -binary | base64url_encode)

    echo "${message}.${signature}"
}

# 生成完整密钥集
generate_keys() {
    echo "Generating JWT keys for project ${PROJECT_REF}..."

    # 生成 JWT Secret
    local jwt_secret
    jwt_secret=$(openssl rand -hex 20)

    # 生成 Anon Key
    local anon_key
    anon_key=$(generate_jwt "$jwt_secret" "anon")

    # 生成 Service Role Key
    local service_role_key
    service_role_key=$(generate_jwt "$jwt_secret" "service_role")

    echo "JWT_SECRET=${jwt_secret}"
    echo "ANON_KEY=${anon_key}"
    echo "SERVICE_ROLE_KEY=${service_role_key}"

    # 保存到项目凭据文件
    local creds_dir="/etc/supabase/projects"
    mkdir -p "$creds_dir"
    local creds_file="${creds_dir}/${PROJECT_REF}.env"

    cat > "$creds_file" <<EOF
# JWT Keys for project: ${PROJECT_REF}
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
JWT_SECRET=${jwt_secret}
ANON_KEY=${anon_key}
SERVICE_ROLE_KEY=${service_role_key}
EOF

    chmod 600 "$creds_file"
    echo "Credentials saved to ${creds_file}"
}

# 主逻辑
validate_params

case "$ACTION" in
    generate)
        generate_keys
        ;;
    *)
        echo "ERROR: Unknown action '${ACTION}'. Use: generate" >&2
        exit 1
        ;;
esac

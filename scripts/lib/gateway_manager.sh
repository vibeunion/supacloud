#!/bin/bash
# SupaCloud - Kong Gateway 管理脚本
# 用法: gateway_manager.sh <action> <project_ref> [args...]

set -euo pipefail

ACTION="${1:-}"
PROJECT_REF="${2:-}"
KONG_ADMIN_URL="${KONG_ADMIN_URL:-http://localhost:8001}"

# 验证参数
validate_params() {
    if [ -z "$ACTION" ] || [ -z "$PROJECT_REF" ]; then
        echo "ERROR: Missing required parameters" >&2
        echo "Usage: $0 <action> <project_ref> [args...]" >&2
        exit 1
    fi
}

# 确保 Consumer 存在
ensure_consumer() {
    curl -s -X POST "${KONG_ADMIN_URL}/consumers" \
        -d "username=${PROJECT_REF}" \
        -d "custom_id=${PROJECT_REF}" > /dev/null
}

# 设置 JWT 凭据
setup_jwt() {
    local jwt_secret="$1"
    ensure_consumer
    
    # 先尝试删除旧的 JWT 凭据（如果存在）
    local existing_id
    existing_id=$(curl -s "${KONG_ADMIN_URL}/consumers/${PROJECT_REF}/jwt" | grep -oP '"id":"\K[^"]+' | head -1 || true)
    if [ -n "$existing_id" ]; then
        curl -s -X DELETE "${KONG_ADMIN_URL}/consumers/${PROJECT_REF}/jwt/${existing_id}" > /dev/null
    fi

    # 创建新的 JWT 凭据
    curl -s -X POST "${KONG_ADMIN_URL}/consumers/${PROJECT_REF}/jwt" \
        -d "key=supabase" \
        -d "secret=${jwt_secret}" \
        -d "algorithm=HS256" > /dev/null
}

# 设置限流
set_rate_limit() {
    local tier="${1:-free}"
    local second=10
    local minute=100
    local hour=1000

    case "$tier" in
        pro)
            second=100; minute=2000; hour=50000 ;;
        enterprise)
            second=1000; minute=50000; hour=1000000 ;;
    esac

    # 为该项目的 Route 绑定 rate-limiting 插件
    # 假设 route 名称为 "route-${PROJECT_REF}"
    local route_name="route-${PROJECT_REF}"
    
    # 获取现有插件 ID (如果有)
    local plugin_id
    plugin_id=$(curl -s "${KONG_ADMIN_URL}/routes/${route_name}/plugins" | grep -oP '"id":"\K[^"]+' | head -1 || true)

    if [ -n "$plugin_id" ]; then
        # 更新现有插件
        curl -s -X PATCH "${KONG_ADMIN_URL}/plugins/${plugin_id}" \
            -d "config.second=${second}" \
            -d "config.minute=${minute}" \
            -d "config.hour=${hour}" \
            -d "config.policy=local" > /dev/null
    else
        # 创建新插件
        curl -s -X POST "${KONG_ADMIN_URL}/routes/${route_name}/plugins" \
            -d "name=rate-limiting" \
            -d "config.second=${second}" \
            -d "config.minute=${minute}" \
            -d "config.hour=${hour}" \
            -d "config.policy=local" > /dev/null
    fi
}

# 设置 CORS
set_cors() {
    local origins="${1:-*}"
    local route_name="route-${PROJECT_REF}"
    
    # 获取现有 cors 插件 ID
    local plugin_id
    plugin_id=$(curl -s "${KONG_ADMIN_URL}/routes/${route_name}/plugins?name=cors" | grep -oP '"id":"\K[^"]+' | head -1 || true)

    if [ -n "$plugin_id" ]; then
        curl -s -X PATCH "${KONG_ADMIN_URL}/plugins/${plugin_id}" \
            -d "config.origins=${origins}" \
            -d "config.methods=GET,POST,PUT,PATCH,DELETE,OPTIONS" \
            -d "config.headers=Accept,Accept-Version,Content-Length,Content-MD5,Content-Type,Date,X-Api-Version,X-Response-Time,X-PINGOTHER,X-CSRF-Token,Authorization" \
            -d "config.exposed_headers=Content-Length,X-JSON" \
            -d "config.credentials=true" \
            -d "config.max_age=3600" > /dev/null
    else
        curl -s -X POST "${KONG_ADMIN_URL}/routes/${route_name}/plugins" \
            -d "name=cors" \
            -d "config.origins=${origins}" \
            -d "config.methods=GET,POST,PUT,PATCH,DELETE,OPTIONS" \
            -d "config.credentials=true" \
            -d "config.max_age=3600" > /dev/null
    fi
}

# 启用 JWT 验证
enable_jwt() {
    local route_name="route-${PROJECT_REF}"
    
    # 检查是否已启用
    if ! curl -s "${KONG_ADMIN_URL}/routes/${route_name}/plugins" | grep -q '"name":"jwt"'; then
        curl -s -X POST "${KONG_ADMIN_URL}/routes/${route_name}/plugins" \
            -d "name=jwt" \
            -d "config.key_claim_name=iss" \
            -d "config.claims_to_verify=exp" > /dev/null
    fi
}

# ========== Per-Tenant Upstream（方案C+：多租户动态路由 - 声明式） ==========
# 将租户配置追加到 Kong Declarative YAML 中并热重载
rebuild_kong_config() {
    # 支持通过 KONG_YML 环境变量覆盖路径，以适配不同部署场景（Pigsty / 自定义安装）
    # 默认路径对应 Pigsty 标准安装目录
    local KONG_YML="${KONG_YML:-/root/pigsty/app/supabase/volumes/api/kong.yml}"
    local KONG_BASE="${KONG_YML}.base"
    local TENANT_DIR="/etc/supabase/kong_tenants"
    
    # 初始化 base 全局配置备份
    if [ ! -f "$KONG_BASE" ]; then
        if [ -f "$KONG_YML" ]; then
            cp "$KONG_YML" "$KONG_BASE"
        else
            echo "WARNING: $KONG_YML not found, skip kong reload" >&2
            return
        fi
    fi
    
    local temp_yml
    temp_yml=$(mktemp)
    
    # 在 services: 后插入所有的租户服务配置段落
    awk -v tenant_dir="$TENANT_DIR" '
    /^services:/ {
        print $0
        system("if ls " tenant_dir "/*.yml >/dev/null 2>&1; then cat " tenant_dir "/*.yml; fi")
        next
    }
    { print $0 }
    ' "$KONG_BASE" > "$temp_yml"
    
    cat "$temp_yml" > "$KONG_YML"
    rm -f "$temp_yml"
    
    # 热重载 Kong 节点
    echo "Reloading Kong Gateway..."
    if docker ps -q -f "name=supabase-kong" | grep -q .; then
        docker exec supabase-kong kong reload
    elif podman ps -q -f "name=supabase-kong" | grep -q .; then
        podman exec supabase-kong kong reload
    else
        echo "WARNING: supabase-kong container not running"
    fi
}

setup_upstream() {
    # 彻底修复：函数内部必须读取自己的位置参数，$1 为 pgrst_port, $2 为 gotrue_port
    local pgrst_port="${1:-}"
    local gotrue_port="${2:-}"
    
    # [变更] Edge Functions 现在使用单实例全局入口，不再依赖单个租户独立分配端口 
    local functions_port="9000"
    
    local storage_port="${4:-}"
    local realtime_port="${5:-}"

    if [ -z "$pgrst_port" ] || [ -z "$gotrue_port" ]; then
        echo "ERROR: pgrst_port and gotrue_port are required for setup-upstream" >&2
        exit 1
    fi

    # 检测宿主机在容器网络中的 IP（供 Kong 容器反向访问宿主机进程）
    # 优先级：环境变量 > podman1 > docker0 > 127.0.0.1
    local host_ip="${DOCKER_HOST_IP:-}"
    if [ -z "$host_ip" ]; then
        host_ip=$(ip addr show podman1 2>/dev/null | grep "inet " | awk '{print $2}' | cut -d/ -f1 || true)
    fi
    if [ -z "$host_ip" ]; then
        host_ip=$(ip addr show docker0 2>/dev/null | grep "inet " | awk '{print $2}' | cut -d/ -f1 || true)
    fi
    if [ -z "$host_ip" ]; then
        host_ip="127.0.0.1"
        echo "WARNING: Could not detect container bridge IP, defaulting to 127.0.0.1 (may cause 502 if Kong runs in container)" >&2
    else
        echo "Detected container-accessible host IP: ${host_ip}"
    fi

    mkdir -p /etc/supabase/kong_tenants
    local tenant_yml="/etc/supabase/kong_tenants/${PROJECT_REF}.yml"

    echo "Setting up Kong declarative configuration for ${PROJECT_REF}..."

    # 生成声明式的 Kong 配置文件
    cat > "$tenant_yml" <<EOF
  - name: svc-pgrst-${PROJECT_REF}
    url: http://${host_ip}:${pgrst_port}
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-pgrst-${PROJECT_REF}
        # 彻底修复：strip_path 必须为 true，否则 Kong 会把路径前缀带给下游导致 404
        strip_path: true
        preserve_host: true
        paths:
          - /rest/v1
          - /graphql/v1
        headers:

          x-project-ref:
            - ${PROJECT_REF}
  - name: svc-gotrue-${PROJECT_REF}
    url: http://${host_ip}:${gotrue_port}
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-gotrue-${PROJECT_REF}
        strip_path: true
        preserve_host: true
        paths:
          - /auth/v1
        headers:

          x-project-ref:
            - ${PROJECT_REF}
EOF

    # 可选服务: Edge Functions
    if [ -n "$functions_port" ]; then
        cat >> "$tenant_yml" <<EOF
  - name: svc-functions-${PROJECT_REF}
    url: http://${host_ip}:${functions_port}
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-functions-${PROJECT_REF}
        strip_path: true
        preserve_host: true
        paths:
          - /functions/v1
          - /functions/v1/
        headers:

          x-project-ref:
            - ${PROJECT_REF}
EOF
    fi

    # 可选服务: Storage
    if [ -n "$storage_port" ]; then
        cat >> "$tenant_yml" <<EOF
  - name: svc-storage-${PROJECT_REF}
    url: http://${host_ip}:${storage_port}
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-storage-${PROJECT_REF}
        strip_path: true
        preserve_host: true
        paths:
          - /storage/v1
        headers:

          x-project-ref:
            - ${PROJECT_REF}
EOF
    fi

    # 可选服务: Realtime
    if [ -n "$realtime_port" ]; then
        cat >> "$tenant_yml" <<EOF
  - name: svc-realtime-${PROJECT_REF}
    url: http://${host_ip}:${realtime_port}
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-realtime-${PROJECT_REF}
        strip_path: true
        preserve_host: true
        paths:
          - /realtime/v1
        headers:

          x-project-ref:
            - ${PROJECT_REF}
EOF
    fi

    rebuild_kong_config
    echo "Kong upstream registered for ${PROJECT_REF} (pgrst:${pgrst_port}, gotrue:${gotrue_port})"
}

# 移除租户的 Kong Service/Route
remove_service() {
    echo "Removing Kong service for ${PROJECT_REF}..."
    rm -f "/etc/supabase/kong_tenants/${PROJECT_REF}.yml"
    rebuild_kong_config
    echo "Kong service removed for ${PROJECT_REF}"
}

# 主逻辑
validate_params

case "$ACTION" in
    setup-project)
        setup_jwt "${3:-}"
        ;;
    set-rate-limit)
        set_rate_limit "${3:-free}"
        ;;
    set-cors)
        set_cors "${3:-*}"
        ;;
    enable-jwt)
        enable_jwt
        ;;
    setup-upstream)
        # 彻底修复：显式传递位置参数 $3 到 $7 给函数内部
        setup_upstream "${3:-}" "${4:-}" "${5:-}" "${6:-}" "${7:-}"
        ;;
    remove-service)
        remove_service
        ;;
    add-upstream-target)
        # 将副本加入负载均衡
        UPSTREAM_NAME="upstream-${PROJECT_REF}-ro"
        REPLICA_IP="${3:-}"
        curl -s -X POST "${KONG_ADMIN_URL}/upstreams" -d "name=${UPSTREAM_NAME}" > /dev/null || true
        curl -s -X POST "${KONG_ADMIN_URL}/upstreams/${UPSTREAM_NAME}/targets" \
            -d "target=${REPLICA_IP}:5432" \
            -d "weight=100" > /dev/null
        echo "Added ${REPLICA_IP} to upstream ${UPSTREAM_NAME}"
        ;;
    remove-upstream-target)
        UPSTREAM_NAME="upstream-${PROJECT_REF}-ro"
        REPLICA_IP="${3:-}"
        curl -s -X POST "${KONG_ADMIN_URL}/upstreams/${UPSTREAM_NAME}/targets" \
            -d "target=${REPLICA_IP}:5432" \
            -d "weight=0" > /dev/null
        echo "Removed ${REPLICA_IP} from upstream ${UPSTREAM_NAME}"
        ;;
    *)
        echo "ERROR: Unknown action '${ACTION}'" >&2
        exit 1
        ;;
esac

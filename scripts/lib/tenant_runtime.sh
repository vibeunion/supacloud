#!/bin/bash
# SupaCloud - Tenant Runtime Management Script
# Dynamically starts independent PostgREST processes for each tenant, binding to unique ports, connecting to dedicated tenant databases
# Usage: tenant_runtime.sh <start|stop|restart|status|port> <project_ref>

set -euo pipefail
umask 077

ACTION="${1:-}"
PROJECT_REF="${2:-}"

# Configuration
TENANT_CONFIG_DIR="${TENANT_CONFIG_DIR:-/etc/supabase/tenants}"
POSTGREST_BIN="${POSTGREST_BIN:-/usr/local/bin/postgrest}"
GOTRUE_BIN="${GOTRUE_BIN:-/usr/local/bin/gotrue}"
PG_HOST="${PG_HOST:-${POSTGRES_HOST:-localhost}}"
PG_PORT="${PG_PORT:-${POSTGRES_PORT:-6432}}"
PGRST_PORT_BASE="${PGRST_PORT_BASE:-3100}"
GOTRUE_PORT_BASE="${GOTRUE_PORT_BASE:-4100}"
PORT_RANGE="${PORT_RANGE:-10000}"
SUPACLOUD_META_DB="${SUPACLOUD_META_DB:-supacloud_meta}"
POSTGREST_RTS="${POSTGREST_RTS:--N1 -M256m -I0.5 -A4m}"
POSTGREST_MEMORY_MAX="${POSTGREST_MEMORY_MAX:-384M}"
POSTGREST_CPU_WEIGHT="${POSTGREST_CPU_WEIGHT:-40}"
POSTGREST_DEFAULT_VERSION="v14.15"
POSTGREST_X86_64_SHA256="4e78c7f065a6c36f350c7177f5fa9bb77ea380c67b8bf40f2fc9130d857678dc"
POSTGREST_ARM64_SHA256="1eb007298c1536ba865e741da7eece6fba6db3da904c599abd15d9c3debe6c2f"
GOTRUE_DEFAULT_VERSION="v2.193.0"
GOTRUE_AMD64_SHA256="c991b6fb8747bbcbcef40701177234f152cea28a108a481bae917bacc1a522c5"
GOTRUE_ARM64_SHA256="432fa68ef58afac8665d45537d8adbba5756b01829f175ed7ef6314b3ca59995"

# Validate parameters
validate_params() {
    if [ -z "$ACTION" ] || [ -z "$PROJECT_REF" ]; then
        echo "ERROR: Missing required parameters" >&2
        echo "Usage: $0 <start|stop|restart|status|port> <project_ref>" >&2
        exit 1
    fi
    if [[ ! "$PROJECT_REF" =~ ^[a-z0-9-]{1,20}$ ]]; then
        echo "ERROR: Invalid project_ref" >&2
        exit 1
    fi
}

tenant_runtime_user() {
    printf 'supacloud-%s' "$1"
}

shared_auth_marker_path() {
    printf '%s/%s_gotrue.shared' "$TENANT_CONFIG_DIR" "$1"
}

resolve_auth_runtime_owner_ref() {
    if [ -n "${SUPACLOUD_AUTH_RUNTIME_OWNER_REF:-}" ]; then
        printf '%s' "$SUPACLOUD_AUTH_RUNTIME_OWNER_REF"
        return
    fi
    command -v systemctl >/dev/null 2>&1 || return 0
    local main_pid
    main_pid=$(systemctl show --property=MainPID --value supacloud.service 2>/dev/null || true)
    if [[ "$main_pid" =~ ^[0-9]+$ ]] && [ "$main_pid" -gt 1 ] && [ -r "/proc/${main_pid}/environ" ]; then
        tr '\0' '\n' < "/proc/${main_pid}/environ" \
            | sed -n 's/^SUPACLOUD_AUTH_RUNTIME_OWNER_REF=//p' \
            | head -1
    fi
}

is_shared_auth_runtime() {
    local ref="$1"
    [ -f "$(shared_auth_marker_path "$ref")" ] && return 0
    local owner_ref
    owner_ref=$(resolve_auth_runtime_owner_ref)
    [ -n "$owner_ref" ] && [ "$owner_ref" != "$ref" ]
}

management_api_active() {
    command -v systemctl >/dev/null 2>&1 || return 2
    local status=0
    systemctl is-active supacloud.service >/dev/null 2>&1 || status=$?
    case "$status" in
        0) return 0 ;;
        3|4) return 1 ;;
        *) return 2 ;;
    esac
}

is_management_api_managed_file() {
    [ -f "$1" ] && grep -Fq '# Managed by SupaCloud Management API.' "$1"
}

should_preserve_runtime_config_on_stop() {
    local ref="$1"
    [ -f "$(shared_auth_marker_path "$ref")" ] && return 0

    local config_path
    for config_path in \
        "${TENANT_CONFIG_DIR}/${ref}.env" \
        "${TENANT_CONFIG_DIR}/${ref}.conf" \
        "${TENANT_CONFIG_DIR}/${ref}_gotrue.env" \
        "${TENANT_CONFIG_DIR}/${ref}_gotrue.d/runtime.env"; do
        is_management_api_managed_file "$config_path" && return 0
    done

    local management_status=0
    management_api_active || management_status=$?
    [ "$management_status" -ne 1 ]
}

stop_shared_gotrue_checked() {
    local ref="$1"
    local unit="supacloud-gotrue@${ref}"
    systemctl stop "$unit"
    systemctl disable "$unit"
}

preserve_management_api_config_if_present() {
    local ref="$1"
    local pgrst_env="${TENANT_CONFIG_DIR}/${ref}.env"
    local pgrst_conf="${TENANT_CONFIG_DIR}/${ref}.conf"
    local gotrue_env="${TENANT_CONFIG_DIR}/${ref}_gotrue.env"
    local gotrue_runtime_env="${TENANT_CONFIG_DIR}/${ref}_gotrue.d/runtime.env"
    local shared_marker
    shared_marker=$(shared_auth_marker_path "$ref")

    if [ -f "$shared_marker" ]; then
        if ! is_management_api_managed_file "$pgrst_env" \
            || ! is_management_api_managed_file "$pgrst_conf"; then
            echo "ERROR: Shared auth config for ${ref} is incomplete; re-apply it through SupaCloud Management API" >&2
            return 1
        fi
        stop_shared_gotrue_checked "$ref" || return 1
        echo "Preserving Management API shared auth config for ${ref}"
        return 0
    fi
    if is_shared_auth_runtime "$ref"; then
        echo "ERROR: Shared auth marker for ${ref} is missing; re-apply it through SupaCloud Management API" >&2
        return 1
    fi

    local managed_file_present=false
    local managed_file
    for managed_file in "$pgrst_env" "$pgrst_conf" "$gotrue_env" "$gotrue_runtime_env"; do
        if is_management_api_managed_file "$managed_file"; then managed_file_present=true; fi
    done
    if [ "$managed_file_present" = true ]; then
        if ! is_management_api_managed_file "$pgrst_env" \
            || ! is_management_api_managed_file "$pgrst_conf" \
            || ! is_management_api_managed_file "$gotrue_env" \
            || ! is_management_api_managed_file "$gotrue_runtime_env"; then
            echo "ERROR: Management API config for ${ref} is incomplete; refusing legacy regeneration" >&2
            return 1
        fi
        if grep -Fq 'GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_REUSE_INTERVAL' "$gotrue_env"; then
            echo "ERROR: Managed GoTrue config still contains the obsolete refresh reuse variable; apply auth config through Management API" >&2
            return 1
        fi
        echo "Preserving Management API managed runtime config for ${ref}"
        return 0
    fi

    local management_status
    if management_api_active; then
        echo "ERROR: Runtime config for ${ref} must be generated by SupaCloud Management API" >&2
        return 1
    else
        management_status=$?
        if [ "$management_status" -eq 2 ]; then
            echo "ERROR: Cannot determine whether SupaCloud Management API owns runtime config for ${ref}" >&2
            return 1
        fi
    fi
    return 2
}

ensure_tenant_runtime_user() {
    local ref="$1"
    local runtime_user
    runtime_user=$(tenant_runtime_user "$ref")
    if ! id -u "$runtime_user" >/dev/null 2>&1; then
        local nologin_shell
        nologin_shell=$(command -v nologin 2>/dev/null || printf '/sbin/nologin')
        useradd --system --user-group --no-create-home --home-dir /nonexistent --shell "$nologin_shell" "$runtime_user"
    fi
    printf '%s' "$runtime_user"
}

# ========== Port allocation (deterministic hash, avoid conflicts) ==========
get_tenant_port() {
    local ref="$1"
    local type="$2" # pgrst or gotrue
    local base_port

    if [ "$type" = "pgrst" ]; then
        base_port=$PGRST_PORT_BASE
    elif [ "$type" = "gotrue" ]; then
        base_port=$GOTRUE_PORT_BASE
    else
        echo "ERROR: Unknown port type $type" >&2
        exit 1
    fi

    local hash
    hash=$(echo -n "$ref" | cksum | awk '{print $1}')
    local port=$(( base_port + (hash % PORT_RANGE) ))

    # Conflict detection: if port is occupied by another tenant, linear probe
    local config_dir="$TENANT_CONFIG_DIR"
    local max_tries=100
    local try=0
    while [ $try -lt $max_tries ]; do
        local conflict=false
        if [ -d "$config_dir" ]; then
            for f in "$config_dir"/*.env; do
                [ -f "$f" ] || continue
                local existing_ref
                # Support ref.env (pgrst) and ref_gotrue.env (gotrue)
                existing_ref=$(basename "$f" | sed -e 's/\.env$//' -e 's/_gotrue$//')
                [ "$existing_ref" = "$ref" ] && continue
                
                local search_str="PGRST_SERVER_PORT=${port}"
                [ "$type" = "gotrue" ] && search_str="GOTRUE_API_PORT=${port}"

                if grep -q "$search_str" "$f" 2>/dev/null; then
                    conflict=true
                    break
                fi
            done
        fi
        if [ "$conflict" = false ]; then
            echo "$port"
            return
        fi
        port=$(( port + 1 ))
        try=$(( try + 1 ))
    done

    echo "ERROR: Cannot find available port for ${ref} (${type})" >&2
    exit 1
}

# ========== Query tenant credentials from supacloud_meta ==========
get_tenant_credentials() {
    local ref="$1"
    local field="$2"
    local output_name="${3:-}"

    case "$field" in
        db_password|jwt_secret|api_url) ;;
        *)
            echo "ERROR: Unsupported tenant credential field: ${field}" >&2
            return 1
            ;;
    esac
    if [ -z "$output_name" ] || [[ ! "$output_name" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
        echo "ERROR: Invalid tenant credential output variable" >&2
        return 1
    fi

    # Use database connection info from environment variables
    # Prefer PG_USER and PGPASSWORD, otherwise fallback to supabase_admin
    local db_user="${PG_USER:-supabase_admin}"
    local db_pass="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
    
    if [ -z "$db_pass" ]; then
        echo "ERROR: PGPASSWORD or POSTGRES_PASSWORD not set" >&2
        exit 1
    fi
    
    local encoded_value
    encoded_value=$(PGPASSWORD="$db_pass" psql \
        -X -q -h "$PG_HOST" -p "$PG_PORT" -U "$db_user" \
        -d "$SUPACLOUD_META_DB" \
        -t -A -v ON_ERROR_STOP=1 \
        -c "SELECT encode(convert_to(COALESCE(${field}, ''), 'UTF8'), 'hex') FROM projects WHERE ref='${ref}'" \
        2>/dev/null) || return 1
    if [[ "$encoded_value" == *$'\n'* || "$encoded_value" == *$'\r'* ]] ||
       [ $(( ${#encoded_value} % 2 )) -ne 0 ] ||
       printf '%s' "$encoded_value" | LC_ALL=C grep -q '[^0-9a-fA-F]'; then
        echo "ERROR: Invalid encoded tenant credential" >&2
        return 1
    fi

    local decoded_escape="" pair index=0
    while [ "$index" -lt "${#encoded_value}" ]; do
        pair="${encoded_value:$index:2}"
        if [ "$pair" = "00" ]; then
            echo "ERROR: Tenant credential contains a forbidden NUL byte" >&2
            return 1
        fi
        decoded_escape="${decoded_escape}\\x${pair}"
        index=$((index + 2))
    done
    printf -v "$output_name" '%b' "$decoded_escape"
}

assert_safe_config_value() {
    local name="${1:-value}"
    local value="${2-}"
    case "$value" in
        *$'\n'*|*$'\r'*)
            echo "ERROR: ${name} contains a forbidden control character" >&2
            return 1
            ;;
    esac
    if printf '%s' "$value" | LC_ALL=C grep -q '[[:cntrl:]]'; then
        echo "ERROR: ${name} contains a forbidden control character" >&2
        return 1
    fi
}

uri_percent_encode() {
    local value="${1-}"
    assert_safe_config_value "URI component" "$value" || return 1

    local LC_ALL=C
    local encoded=""
    local char hex index
    index=0
    while [ "$index" -lt "${#value}" ]; do
        char="${value:$index:1}"
        case "$char" in
            [a-zA-Z0-9.~_-]) encoded="${encoded}${char}" ;;
            *)
                printf -v hex '%%%02X' "'$char"
                encoded="${encoded}${hex}"
                ;;
        esac
        index=$((index + 1))
    done
    printf '%s' "$encoded"
}

systemd_env_quote() {
    local value="${1-}"
    assert_safe_config_value "EnvironmentFile value" "$value" || return 1
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    printf '"%s"' "$value"
}

toml_basic_string() {
    local value="${1-}"
    assert_safe_config_value "TOML value" "$value" || return 1
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    printf '"%s"' "$value"
}

write_tenant_secret_file() (
    set -e
    local target="$1"
    local runtime_user="$2"
    local content="$3"
    local target_dir tmp_file=""
    target_dir=$(dirname "$target") || return 1
    mkdir -p "$target_dir" || return 1
    tmp_file=$(mktemp "${target}.tmp.XXXXXX") || return 1
    trap 'if [ -n "${tmp_file:-}" ]; then rm -f -- "$tmp_file"; fi' EXIT HUP INT TERM
    printf '%s\n' "$content" > "$tmp_file" || return 1
    chown "$runtime_user:$runtime_user" "$tmp_file" || return 1
    chmod 600 "$tmp_file" || return 1
    mv -f "$tmp_file" "$target" || return 1
    tmp_file=""
    chown "$runtime_user:$runtime_user" "$target" || return 1
    chmod 600 "$target" || return 1
)

resolve_release_sha256() {
    local component="$1"
    local version="$2"
    local default_version="$3"
    local default_sha256="$4"
    local explicit_sha256="${5:-}"
    local resolved

    if [ "$version" != "$default_version" ] && [ -z "$explicit_sha256" ]; then
        echo "ERROR: ${component} ${version} requires an explicit SHA256 override" >&2
        return 1
    fi
    resolved="${explicit_sha256:-$default_sha256}"
    if [ "${#resolved}" -ne 64 ] || printf '%s' "$resolved" | LC_ALL=C grep -q '[^0-9a-fA-F]'; then
        echo "ERROR: Invalid SHA256 for ${component} ${version}" >&2
        return 1
    fi
    printf '%s' "$resolved" | tr '[:upper:]' '[:lower:]'
}

sha256_file() {
    local file_path="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file_path" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file_path" | awk '{print $1}'
    else
        echo "ERROR: sha256sum or shasum is required" >&2
        return 1
    fi
}

download_release_asset() {
    local url="$1"
    local output_path="$2"
    assert_safe_config_value "release URL" "$url" || return 1
    case "$url" in
        https://github.com/*) ;;
        *)
            echo "ERROR: Release assets must use the official GitHub origin" >&2
            return 1
            ;;
    esac

    if curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fL --retry 3 --connect-timeout 15 "$url" -o "$output_path"; then
        return 0
    fi
    rm -f -- "$output_path"

    local proxy="${SUPACLOUD_GITHUB_PROXY:-}"
    if [ -z "$proxy" ]; then
        return 1
    fi
    assert_safe_config_value "SUPACLOUD_GITHUB_PROXY" "$proxy" || return 1
    case "$proxy" in
        https://*) ;;
        *)
            echo "ERROR: SUPACLOUD_GITHUB_PROXY must use https://" >&2
            return 1
            ;;
    esac
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fL --retry 3 --connect-timeout 15 "${proxy%/}/${url}" -o "$output_path"
}

validate_release_tar() (
    set -e
    local archive_path="$1"
    shift
    local listing_file verbose_file candidate_file member expected regular_count candidate_count
    listing_file=$(mktemp) || return 1
    verbose_file=$(mktemp) || return 1
    candidate_file=$(mktemp) || return 1
    trap 'rm -f -- "$listing_file" "$verbose_file" "$candidate_file"' EXIT HUP INT TERM

    tar -tf "$archive_path" > "$listing_file" || return 1
    tar -tvf "$archive_path" > "$verbose_file" || return 1

    if printf '%s' "$(cat "$listing_file")" | LC_ALL=C grep -q '[[:cntrl:]]'; then
        echo "ERROR: Release archive contains control characters in member names" >&2
        return 1
    fi
    while IFS= read -r member; do
        case "$member" in
            /*|..|../*|*/..|*/../*)
                echo "ERROR: Unsafe release archive member: ${member}" >&2
                return 1
                ;;
        esac
        for expected in "$@"; do
            if [ "$member" = "$expected" ] || [ "$member" = "./${expected}" ]; then
                printf '%s\n' "$member" >> "$candidate_file"
            fi
        done
    done < "$listing_file"

    if ! awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { exit 1 }' "$verbose_file"; then
        echo "ERROR: Release archive contains links or special files" >&2
        return 1
    fi
    regular_count=$(awk 'substr($0, 1, 1) == "-" { count++ } END { print count + 0 }' "$verbose_file") || return 1
    candidate_count=$(wc -l < "$candidate_file" | tr -d ' ') || return 1
    if [ "$regular_count" -ne 1 ] || [ "$candidate_count" -ne 1 ]; then
        echo "ERROR: Release archive must contain exactly one expected binary" >&2
        return 1
    fi
    sed -n '1p' "$candidate_file" || return 1
)

validate_elf_binary() {
    local binary_path="$1"
    local machine="$2"
    local description
    description=$(file -b "$binary_path")
    case "$machine" in
        x86_64)
            case "$description" in *ELF*64-bit*x86-64*) ;; *)
                echo "ERROR: Binary is not an x86_64 ELF executable" >&2
                return 1
                ;;
            esac
            ;;
        aarch64)
            case "$description" in *ELF*64-bit*ARM*aarch64*|*ELF*64-bit*aarch64*) ;; *)
                echo "ERROR: Binary is not an arm64 ELF executable" >&2
                return 1
                ;;
            esac
            ;;
        *)
            echo "ERROR: Unsupported ELF architecture: ${machine}" >&2
            return 1
            ;;
    esac
}

smoke_check_binary() {
    local binary_path="$1"
    if command -v timeout >/dev/null 2>&1; then
        timeout 10 "$binary_path" --version >/dev/null 2>&1 ||
            timeout 10 "$binary_path" --help >/dev/null 2>&1
    else
        "$binary_path" --version >/dev/null 2>&1 || "$binary_path" --help >/dev/null 2>&1
    fi
}

install_verified_tar_binary() (
    set -e
    local archive_path="$1"
    local expected_sha256="$2"
    local target_path="$3"
    local machine="$4"
    shift 4
    local actual_sha256 member work_dir="" install_tmp=""

    actual_sha256=$(sha256_file "$archive_path" | tr '[:upper:]' '[:lower:]') || return 1
    if [ "$actual_sha256" != "$expected_sha256" ]; then
        echo "ERROR: Release asset SHA256 mismatch" >&2
        return 1
    fi
    member=$(validate_release_tar "$archive_path" "$@") || return 1

    work_dir=$(mktemp -d) || return 1
    trap 'rm -rf -- "${work_dir:-}"; if [ -n "${install_tmp:-}" ]; then rm -f -- "$install_tmp"; fi' EXIT HUP INT TERM
    tar -xOf "$archive_path" "$member" > "${work_dir}/binary" || return 1
    [ -s "${work_dir}/binary" ] || return 1
    validate_elf_binary "${work_dir}/binary" "$machine" || return 1

    mkdir -p "$(dirname "$target_path")" || return 1
    install_tmp=$(mktemp "$(dirname "$target_path")/.$(basename "$target_path").XXXXXX") || return 1
    install -m 0755 "${work_dir}/binary" "$install_tmp" || return 1
    validate_elf_binary "$install_tmp" "$machine" || return 1
    smoke_check_binary "$install_tmp" || return 1
    mv -f "$install_tmp" "$target_path" || return 1
    install_tmp=""
)

# ========== Ensure PostgREST binary is available ==========
ensure_postgrest() {
    if command -v postgrest &>/dev/null; then
        POSTGREST_BIN=$(command -v postgrest)
        return
    fi

    if [ -x "$POSTGREST_BIN" ]; then
        return
    fi

    echo "PostgREST binary not found. Installing..."

    local machine arch default_sha256
    machine=$(uname -m)
    case "$machine" in
        x86_64) arch="linux-static-x86-64"; default_sha256="$POSTGREST_X86_64_SHA256" ;;
        aarch64) arch="ubuntu-aarch64"; default_sha256="$POSTGREST_ARM64_SHA256" ;;
        *) echo "ERROR: Unsupported architecture: $machine" >&2; exit 1 ;;
    esac

    local version="${POSTGREST_VERSION:-v14.15}"
    local expected_sha256
    assert_safe_config_value "POSTGREST_VERSION" "$version" || exit 1
    case "$version" in *[!A-Za-z0-9._-]*|"") echo "ERROR: Invalid POSTGREST_VERSION" >&2; exit 1 ;; esac
    expected_sha256=$(resolve_release_sha256 "PostgREST" "$version" "$POSTGREST_DEFAULT_VERSION" "$default_sha256" "${POSTGREST_SHA256:-}") || exit 1
    local url="https://github.com/PostgREST/postgrest/releases/download/${version}/postgrest-${version}-${arch}.tar.xz"
    echo "Downloading PostgREST ${version}..."

    (
        set -e
        local tmp_dir
        tmp_dir=$(mktemp -d) || exit 1
        trap 'rm -rf -- "$tmp_dir"' EXIT HUP INT TERM
        download_release_asset "$url" "${tmp_dir}/postgrest.tar.xz" || exit 1
        install_verified_tar_binary "${tmp_dir}/postgrest.tar.xz" "$expected_sha256" "$POSTGREST_BIN" "$machine" postgrest || exit 1
    ) || { echo "ERROR: Failed to install PostgREST" >&2; exit 1; }
    echo "PostgREST installed to $POSTGREST_BIN"
}

# ========== Ensure GoTrue binary is available ==========
ensure_gotrue() {
    if command -v gotrue &>/dev/null; then
        GOTRUE_BIN=$(command -v gotrue)
        return
    fi

    if [ -x "$GOTRUE_BIN" ]; then
        return
    fi

    echo "GoTrue binary not found. Installing..."

    local machine arch default_sha256
    machine=$(uname -m)
    case "$machine" in
        x86_64) arch="amd64"; default_sha256="$GOTRUE_AMD64_SHA256" ;;
        aarch64) arch="arm64"; default_sha256="$GOTRUE_ARM64_SHA256" ;;
        *) echo "ERROR: Unsupported architecture: $machine" >&2; exit 1 ;;
    esac

    local version="${GOTRUE_VERSION:-v2.193.0}"
    local archive_ext="tar.xz"
    local expected_sha256
    assert_safe_config_value "GOTRUE_VERSION" "$version" || exit 1
    case "$version" in *[!A-Za-z0-9._-]*|"") echo "ERROR: Invalid GOTRUE_VERSION" >&2; exit 1 ;; esac
    expected_sha256=$(resolve_release_sha256 "GoTrue" "$version" "$GOTRUE_DEFAULT_VERSION" "$default_sha256" "${GOTRUE_SHA256:-}") || exit 1
    local url="https://github.com/supabase/auth/releases/download/${version}/auth-${version}-${arch}.${archive_ext}"
    echo "Downloading GoTrue ${version}..."

    (
        set -e
        local tmp_dir
        tmp_dir=$(mktemp -d) || exit 1
        trap 'rm -rf -- "$tmp_dir"' EXIT HUP INT TERM
        download_release_asset "$url" "${tmp_dir}/gotrue.tar.xz" || exit 1
        install_verified_tar_binary "${tmp_dir}/gotrue.tar.xz" "$expected_sha256" "$GOTRUE_BIN" "$machine" auth gotrue || exit 1
    ) || { echo "ERROR: Failed to install GoTrue. Please manually place the binary at $GOTRUE_BIN" >&2; exit 1; }
    echo "GoTrue installed to $GOTRUE_BIN"
}

# ========== Generate tenant configuration files ==========
generate_tenant_config() {
    local ref="$1"
    local pgrst_port="$2"
    local gotrue_port="$3"

    case "$ref" in
        *[!a-z0-9-]*|"")
            echo "ERROR: Invalid project_ref" >&2
            return 1
            ;;
    esac
    if [[ ! "$pgrst_port" =~ ^[0-9]+$ || ! "$gotrue_port" =~ ^[0-9]+$ ]] ||
       [ "$pgrst_port" -lt 1 ] || [ "$pgrst_port" -gt 65535 ] ||
       [ "$gotrue_port" -lt 1 ] || [ "$gotrue_port" -gt 65535 ]; then
        echo "ERROR: Invalid tenant runtime port" >&2
        return 1
    fi

    local runtime_user
    runtime_user=$(ensure_tenant_runtime_user "$ref") || return 1
    mkdir -p "$TENANT_CONFIG_DIR" || return 1
    chmod 711 "$TENANT_CONFIG_DIR" || return 1

    local managed_config_status
    if preserve_management_api_config_if_present "$ref"; then
        return 0
    else
        managed_config_status=$?
        if [ "$managed_config_status" -ne 2 ]; then return "$managed_config_status"; fi
    fi
    if is_shared_auth_runtime "$ref"; then
        echo "ERROR: Shared auth runtime ${ref} requires Management API generated PostgREST config" >&2
        return 1
    fi

    # Query tenant credentials
    local db_name="supa_${ref}"
    local db_password
    get_tenant_credentials "$ref" "db_password" db_password || return 1
    local jwt_secret
    get_tenant_credentials "$ref" "jwt_secret" jwt_secret || return 1

    if [ -z "$db_password" ] || [ -z "$jwt_secret" ]; then
        echo "ERROR: Cannot find credentials for project ${ref} in supacloud_meta" >&2
        exit 1
    fi
    assert_safe_config_value "tenant database password" "$db_password" || return 1
    assert_safe_config_value "tenant JWT secret" "$jwt_secret" || return 1
    assert_safe_config_value "PostgreSQL host" "$PG_HOST" || return 1
    assert_safe_config_value "PostgreSQL port" "$PG_PORT" || return 1

    local pgrst_db_schemas="public,storage,graphql_public"
    local pgrst_db_schemas_conf="public, storage, graphql_public"
    local pgmq_public_exists=""
    if command -v psql >/dev/null 2>&1; then
        pgmq_public_exists=$(PGPASSWORD="$db_password" psql \
            -h "$PG_HOST" -p "$PG_PORT" -U "authenticator_${ref}" -d "$db_name" \
            -Atqc "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgmq_public') THEN 1 ELSE 0 END;" \
            2>/dev/null || true)
    fi
    if [ "$pgmq_public_exists" = "1" ]; then
        pgrst_db_schemas="${pgrst_db_schemas},pgmq_public"
        pgrst_db_schemas_conf="${pgrst_db_schemas_conf}, pgmq_public"
    fi

    # Query tenant's API external access URL (for GoTrue API_EXTERNAL_URL)
    # Priority: environment variable override > supacloud_meta.projects.api_url > default placeholder
    local api_external_url="${GOTRUE_API_EXTERNAL_URL:-}"
    if [ -z "$api_external_url" ]; then
        get_tenant_credentials "$ref" "api_url" api_external_url 2>/dev/null || api_external_url=""
    fi
    if [ -z "$api_external_url" ]; then
        api_external_url="https://your-supacloud-domain.com"
        echo "WARNING: API_EXTERNAL_URL not set. Set GOTRUE_API_EXTERNAL_URL env var or add api_url to supacloud_meta.projects" >&2
    fi
    assert_safe_config_value "GoTrue external URL" "$api_external_url" || return 1

    local authenticator_user="authenticator_${ref}"
    local encoded_authenticator_user encoded_db_password encoded_admin_user encoded_admin_password encoded_db_name
    encoded_authenticator_user=$(uri_percent_encode "$authenticator_user") || return 1
    encoded_db_password=$(uri_percent_encode "$db_password") || return 1
    encoded_admin_user=$(uri_percent_encode "supabase_auth_admin") || return 1
    local admin_db_password="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
    if [ -z "$admin_db_password" ]; then
        echo "ERROR: PGPASSWORD or POSTGRES_PASSWORD not set" >&2
        return 1
    fi
    encoded_admin_password=$(uri_percent_encode "$admin_db_password") || return 1
    encoded_db_name=$(uri_percent_encode "$db_name") || return 1
    local tenant_db_uri="postgres://${encoded_authenticator_user}:${encoded_db_password}@${PG_HOST}:${PG_PORT}/${encoded_db_name}"
    local auth_db_uri="postgres://${encoded_admin_user}:${encoded_admin_password}@${PG_HOST}:${PG_PORT}/${encoded_db_name}"

    # 1. Generate PostgREST .env and .conf
    local pgrst_env
    pgrst_env=$(cat <<EOF
# SupaCloud Tenant PostgREST Runtime: ${ref}
PGRST_DB_URI=$(systemd_env_quote "$tenant_db_uri")
PGRST_DB_SCHEMAS=$(systemd_env_quote "$pgrst_db_schemas")
PGRST_DB_EXTRA_SEARCH_PATH="public"
PGRST_DB_ANON_ROLE="anon"
PGRST_JWT_SECRET=$(systemd_env_quote "$jwt_secret")
PGRST_SERVER_PORT=${pgrst_port}
PGRST_DB_POOL=3
PGRST_DB_POOL_ACQUISITION_TIMEOUT=10
PGRST_LOG_LEVEL="warn"
EOF
)
    write_tenant_secret_file "${TENANT_CONFIG_DIR}/${ref}.env" "$runtime_user" "$pgrst_env" || return 1

    local pgrst_conf
    pgrst_conf=$(cat <<EOF
# PostgREST config for tenant: ${ref}
db-uri = $(toml_basic_string "$tenant_db_uri")
db-schemas = $(toml_basic_string "$pgrst_db_schemas_conf")
# Bug Fix: Multi-tenant isolation - extra search path should include tenant-specific schema
db-extra-search-path = $(toml_basic_string "public, extensions, auth, ${ref}")
db-anon-role = "anon"
jwt-secret = $(toml_basic_string "$jwt_secret")
server-port = ${pgrst_port}
# Bind to 0.0.0.0 so the host gateway can reach the tenant runtime.
server-host = "0.0.0.0"
db-pool = 3
db-pool-acquisition-timeout = 10
log-level = "warn"
db-channel = $(toml_basic_string "pgrst_${ref}")
EOF
)
    write_tenant_secret_file "${TENANT_CONFIG_DIR}/${ref}.conf" "$runtime_user" "$pgrst_conf" || return 1

    # 2. Generate GoTrue .env
    # Get tenant configured email sender (if any)
    local gotrue_sender="${GOTRUE_SMTP_ADMIN_EMAIL:-noreply@${api_external_url#https://}}"
    local smtp_host="${GOTRUE_SMTP_HOST:-}"
    local smtp_user="${GOTRUE_SMTP_USER:-}"
    local smtp_pass="${GOTRUE_SMTP_PASS:-}"
    assert_safe_config_value "GoTrue SMTP sender" "$gotrue_sender" || return 1
    assert_safe_config_value "GoTrue SMTP host" "$smtp_host" || return 1
    assert_safe_config_value "GoTrue SMTP user" "$smtp_user" || return 1
    assert_safe_config_value "GoTrue SMTP password" "$smtp_pass" || return 1
    
    local gotrue_config_dir="${TENANT_CONFIG_DIR}/${ref}_gotrue.d"
    mkdir -p "$gotrue_config_dir" || return 1
    chown "$runtime_user:$runtime_user" "$gotrue_config_dir" || return 1
    chmod 700 "$gotrue_config_dir" || return 1

    local gotrue_env
    gotrue_env=$(cat <<EOF
# SupaCloud Tenant GoTrue Runtime: ${ref}
# Bind to 0.0.0.0 so the host gateway can reach the tenant runtime.
GOTRUE_API_HOST="0.0.0.0"
GOTRUE_API_PORT=${gotrue_port}
# Required: external URL used for email verification links and OAuth redirects
API_EXTERNAL_URL=$(systemd_env_quote "$api_external_url")
# Bug Fix: SITE_URL should be the actually accessible URL
GOTRUE_SITE_URL=$(systemd_env_quote "$api_external_url")
GOTRUE_DB_DRIVER="postgres"
GOTRUE_DB_DATABASE_URL=$(systemd_env_quote "$auth_db_uri")

GOTRUE_JWT_SECRET=$(systemd_env_quote "$jwt_secret")
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_AUD="authenticated"
GOTRUE_JWT_DEFAULT_GROUP_NAME="authenticated"
# Bug Fix: Must set JWT_AUD, otherwise user queries will be filtered out due to empty aud
GOTRUE_JWT_AUD="authenticated"
GOTRUE_LOG_LEVEL="info"
GOTRUE_SERVER_READ_TIMEOUT=20
GOTRUE_RELOADING_SIGNAL_ENABLED="true"
GOTRUE_RELOADING_POLLER_ENABLED="true"
GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION="true"
GOTRUE_PASSWORD_MIN_LENGTH=8
GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED="true"
GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=10
GOTRUE_SESSIONS_SINGLE_PER_USER="false"
EOF
)

    # If SMTP is configured, add to GoTrue config
    if [ -n "$smtp_host" ]; then
        gotrue_env="${gotrue_env}
# SMTP Configuration
GOTRUE_SMTP_ADMIN_EMAIL=$(systemd_env_quote "$gotrue_sender")
GOTRUE_SMTP_HOST=$(systemd_env_quote "$smtp_host")
GOTRUE_SMTP_PORT=587
GOTRUE_SMTP_USER=$(systemd_env_quote "$smtp_user")
GOTRUE_SMTP_PASS=$(systemd_env_quote "$smtp_pass")
GOTRUE_SMTP_SENDER_NAME=$(systemd_env_quote "SupaCloud")"
    fi
    write_tenant_secret_file "${TENANT_CONFIG_DIR}/${ref}_gotrue.env" "$runtime_user" "$gotrue_env" || return 1
    write_tenant_secret_file "${gotrue_config_dir}/runtime.env" "$runtime_user" "$gotrue_env" || return 1

    echo "Config generated for ${ref} (pgrst_port=${pgrst_port}, gotrue_port=${gotrue_port})"
}

# ========== Install systemd template unit ==========
install_systemd_template() {
    local pgrst_unit="/etc/systemd/system/supacloud-pgrst@.service"
    if [ ! -f "$pgrst_unit" ] || grep -Eq -- '-M30m|MemoryMax=45M|^User=nobody$' "$pgrst_unit"; then
        cat > "$pgrst_unit" <<EOF
[Unit]
Description=SupaCloud PostgREST for tenant %i
Documentation=https://github.com/supacloud/supacloud
After=network.target patroni.service
Wants=patroni.service

[Service]
Type=simple
User=supacloud-%i
Group=supacloud-%i
EnvironmentFile=/etc/supabase/tenants/%i.env
# Keep PostgREST bounded without starving large REST reads/upserts.
Environment="GHCRTS=${POSTGREST_RTS}"
ExecStart=${POSTGREST_BIN} /etc/supabase/tenants/%i.conf +RTS ${POSTGREST_RTS} -RTS
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60

# Security and resource sandboxing
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/supabase/tenants
MemoryMax=${POSTGREST_MEMORY_MAX}
CPUWeight=${POSTGREST_CPU_WEIGHT}

[Install]
WantedBy=multi-user.target
EOF
    fi

    local gotrue_unit="/etc/systemd/system/supacloud-gotrue@.service"
    if [ ! -f "$gotrue_unit" ] || ! grep -q -- '--config-dir /etc/supabase/tenants/%i_gotrue.d' "$gotrue_unit" || grep -q '^User=nobody$' "$gotrue_unit"; then
        cat > "$gotrue_unit" <<EOF
[Unit]
Description=SupaCloud GoTrue for tenant %i
Documentation=https://github.com/supacloud/supacloud
After=network.target patroni.service
Wants=patroni.service

[Service]
Type=simple
User=supacloud-%i
Group=supacloud-%i
EnvironmentFile=/etc/supabase/tenants/%i_gotrue.env
# Extreme squeeze: Go native memory wall 15MB and trigger GC immediately at 20% growth
Environment="GOMEMLIMIT=15MiB"
Environment="GOGC=20"
ExecStart=${GOTRUE_BIN} --config-dir /etc/supabase/tenants/%i_gotrue.d
ExecReload=/bin/kill -USR1 \$MAINPID
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60

# Security and resource sandboxing
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/supabase/tenants
MemoryMax=30M
CPUWeight=20

[Install]
WantedBy=multi-user.target
EOF
    fi

    systemctl daemon-reload
    echo "systemd template units installed"
}

# ========== Start tenant runtime ==========
start_runtime() {
    local ref="$1"
    local shared_auth=false
    if is_shared_auth_runtime "$ref"; then shared_auth=true; fi

    ensure_postgrest
    if [ "$shared_auth" = false ]; then ensure_gotrue; fi
    install_systemd_template

    local pgrst_port
    pgrst_port=$(get_tenant_port "$ref" "pgrst")
    local gotrue_port
    gotrue_port=$(get_tenant_port "$ref" "gotrue")

    # Generate config
    generate_tenant_config "$ref" "$pgrst_port" "$gotrue_port"

    # Start systemd services
    systemctl enable "supacloud-pgrst@${ref}" 2>/dev/null || true
    systemctl start "supacloud-pgrst@${ref}"
    
    if [ "$shared_auth" = true ]; then
        stop_shared_gotrue_checked "$ref"
    else
        systemctl enable "supacloud-gotrue@${ref}" 2>/dev/null || true
        systemctl start "supacloud-gotrue@${ref}"
    fi

    # Wait for health check (check both ports)
    if [ "$shared_auth" = true ]; then
        echo "Waiting for PostgREST(${pgrst_port}) with shared authentication boundary..."
    else
        echo "Waiting for PostgREST(${pgrst_port}) and GoTrue(${gotrue_port})..."
    fi
    local retries=20
    local pgrst_ok=0
    local gotrue_ok=0
    
    while [ $retries -gt 0 ]; do
        if [ $pgrst_ok -eq 0 ] && curl -sf "http://127.0.0.1:${pgrst_port}/" >/dev/null 2>&1; then
            pgrst_ok=1
        fi
        if [ "$shared_auth" = true ]; then
            gotrue_ok=1
        elif [ $gotrue_ok -eq 0 ] && curl -sf "http://127.0.0.1:${gotrue_port}/health" >/dev/null 2>&1; then
            gotrue_ok=1
        fi
        
        if [ $pgrst_ok -eq 1 ] && [ $gotrue_ok -eq 1 ]; then
            echo "RUNTIME_STARTED=true"
            echo "PORT=${pgrst_port}"
            echo "GOTRUE_PORT=${gotrue_port}"
            echo "GOTRUE_MODE=$([ "$shared_auth" = true ] && printf shared || printf local)"
            echo "STATUS=running"
            return
        fi
        sleep 1
        retries=$((retries - 1))
    done

    echo "WARNING: Health check timeout, some services may still be starting" >&2
    echo "RUNTIME_STARTED=true"
    echo "PORT=${pgrst_port}"
    echo "GOTRUE_PORT=${gotrue_port}"
    echo "STATUS=starting"
}

# ========== Stop tenant runtime ==========
stop_runtime() {
    local ref="$1"
    local runtime_user
    runtime_user=$(tenant_runtime_user "$ref")
    local preserve_config=false
    if should_preserve_runtime_config_on_stop "$ref"; then preserve_config=true; fi

    systemctl stop "supacloud-pgrst@${ref}" 2>/dev/null || true
    systemctl disable "supacloud-pgrst@${ref}" 2>/dev/null || true
    
    systemctl stop "supacloud-gotrue@${ref}" 2>/dev/null || true
    systemctl disable "supacloud-gotrue@${ref}" 2>/dev/null || true

    if [ "$preserve_config" = true ]; then
        echo "Runtime stopped for ${ref}; Management API config preserved"
        return
    fi

    rm -rf "${TENANT_CONFIG_DIR}/${ref}.env" "${TENANT_CONFIG_DIR}/${ref}.conf" "${TENANT_CONFIG_DIR}/${ref}_gotrue.env" "${TENANT_CONFIG_DIR}/${ref}_gotrue.d" "$(shared_auth_marker_path "$ref")"
    userdel "$runtime_user" 2>/dev/null || true
    echo "Runtime stopped for ${ref}"
}

# ========== Restart tenant runtime ==========
restart_runtime() {
    local ref="$1"
    local shared_auth=false
    if is_shared_auth_runtime "$ref"; then shared_auth=true; fi

    if systemctl is-active "supacloud-pgrst@${ref}" >/dev/null 2>&1 || systemctl is-active "supacloud-gotrue@${ref}" >/dev/null 2>&1; then
        # Bug Fix: Before restart, also need to ensure binary and systemd template exist, prevent crash if .service not allocated
        ensure_postgrest
        if [ "$shared_auth" = false ]; then ensure_gotrue; fi
        install_systemd_template

        # Regenerate config (credentials may have been updated)
        local pgrst_port
        pgrst_port=$(get_tenant_port "$ref" "pgrst")
        local gotrue_port
        gotrue_port=$(get_tenant_port "$ref" "gotrue")
        
        generate_tenant_config "$ref" "$pgrst_port" "$gotrue_port"
        
        systemctl restart "supacloud-pgrst@${ref}"
        if [ "$shared_auth" = true ]; then
            stop_shared_gotrue_checked "$ref"
        else
            systemctl restart "supacloud-gotrue@${ref}"
        fi
        echo "Runtime restarted for ${ref} (pgrst=${pgrst_port}, gotrue=${gotrue_port})"
    else
        # Not running, start it
        start_runtime "$ref"
    fi
}

# ========== Check status ==========
check_status() {
    local ref="$1"
    local shared_auth=false
    if is_shared_auth_runtime "$ref"; then shared_auth=true; fi

    local pgrst_running=false
    local gotrue_running=false
    
    systemctl is-active "supacloud-pgrst@${ref}" >/dev/null 2>&1 && pgrst_running=true
    systemctl is-active "supacloud-gotrue@${ref}" >/dev/null 2>&1 && gotrue_running=true

    if [ "$pgrst_running" = true ] || [ "$gotrue_running" = true ]; then
        local pgrst_port
        pgrst_port=$(get_tenant_port "$ref" "pgrst")
        local gotrue_port
        gotrue_port=$(get_tenant_port "$ref" "gotrue")
        
        local health="unhealthy"
        if curl -sf "http://127.0.0.1:${pgrst_port}/" >/dev/null 2>&1 \
            && { [ "$shared_auth" = true ] || curl -sf "http://127.0.0.1:${gotrue_port}/health" >/dev/null 2>&1; }; then
            health="healthy"
        elif curl -sf "http://127.0.0.1:${pgrst_port}/" >/dev/null 2>&1 || curl -sf "http://127.0.0.1:${gotrue_port}/health" >/dev/null 2>&1; then
            health="degraded"
        fi
        
        echo "STATUS=running"
        echo "PORT=${pgrst_port}"
        echo "GOTRUE_PORT=${gotrue_port}"
        echo "GOTRUE_MODE=$([ "$shared_auth" = true ] && printf shared || printf local)"
        echo "HEALTH=${health}"
    else
        echo "STATUS=stopped"
    fi
}

# ========== Get port ==========
get_port() {
    local ref="$1"
    local pgrst_port
    pgrst_port=$(get_tenant_port "$ref" "pgrst")
    local gotrue_port
    gotrue_port=$(get_tenant_port "$ref" "gotrue")
    echo "PORT=${pgrst_port}"
    echo "GOTRUE_PORT=${gotrue_port}"
}

tenant_runtime_main() {
    validate_params

    case "$ACTION" in
        start)
            start_runtime "$PROJECT_REF"
            ;;
        stop)
            stop_runtime "$PROJECT_REF"
            ;;
        restart)
            restart_runtime "$PROJECT_REF"
            ;;
        status)
            check_status "$PROJECT_REF"
            ;;
        port)
            get_port "$PROJECT_REF"
            ;;
        *)
            echo "ERROR: Unknown action '${ACTION}'. Use: start, stop, restart, status, port" >&2
            exit 1
            ;;
    esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    tenant_runtime_main
fi

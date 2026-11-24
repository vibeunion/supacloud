#!/usr/bin/env bash

set -euo pipefail
umask 077
export LC_ALL=C

project_ref="${1:-}"
if [[ ! "$project_ref" =~ ^[a-z0-9-]{1,64}$ ]]; then
    echo "ERROR: Invalid tenant project ref" >&2
    exit 2
fi
shift

config_root="${SUPACLOUD_POSTGREST_CONFIG_DIR:-/etc/supabase/tenants}"
config_trust_root="${SUPACLOUD_POSTGREST_CONFIG_TRUST_ROOT:-/etc/supabase}"
postgrest_binary="${SUPACLOUD_POSTGREST_BIN:-/usr/local/bin/postgrest}"
binary_trust_root="${SUPACLOUD_POSTGREST_BINARY_TRUST_ROOT:-/usr/local}"
control_uid="${SUPACLOUD_POSTGREST_CONTROL_UID:-0}"
runtime_uid=$(id -u)
runtime_gid=$(id -g)

[[ "$runtime_uid" =~ ^[0-9]+$ && "$runtime_uid" -gt 0 \
    && "$runtime_gid" =~ ^[0-9]+$ \
    && "$control_uid" =~ ^[0-9]+$ ]] || {
    echo "ERROR: Invalid PostgREST runtime identity" >&2
    exit 1
}

file_metadata() {
    if stat -c '%u %g %a %h %d:%i:%s:%Y:%Z' -- "$1" >/dev/null 2>&1; then
        stat -c '%u %g %a %h %d:%i:%s:%Y:%Z' -- "$1"
    else
        local uid gid raw_mode links identity
        read -r uid gid raw_mode links identity <<< "$(stat -f '%u %g %p %l %d:%i:%z:%m:%c' -- "$1")"
        printf '%s %s %o %s %s\n' "$uid" "$gid" "$((8#$raw_mode & 8#7777))" "$links" "$identity"
    fi
}

assert_directory() {
    local target="$1" expected_uid="$2" expected_gid="$3" expected_mode="$4"
    local uid gid mode links identity
    [[ -d "$target" && ! -L "$target" ]] || return 1
    read -r uid gid mode links identity <<< "$(file_metadata "$target")"
    [[ "$uid" = "$expected_uid" && "$gid" = "$expected_gid" && "$mode" = "$expected_mode" ]]
}

assert_control_root() {
    local target="$1" expected_uid="$2"
    local uid gid mode links identity
    [[ -d "$target" && ! -L "$target" ]] || return 1
    read -r uid gid mode links identity <<< "$(file_metadata "$target")"
    [[ "$uid" = "$expected_uid" && "$mode" = 711 ]]
}

assert_trusted_directory() {
    local target="$1" expected_uid="$2"
    local uid gid mode links identity mode_value
    [[ -d "$target" && ! -L "$target" ]] || return 1
    read -r uid gid mode links identity <<< "$(file_metadata "$target")"
    mode_value=$((8#$mode))
    [[ "$uid" = "$expected_uid" && $((mode_value & 8#022)) -eq 0 ]]
}

assert_regular_file() {
    local target="$1" expected_uid="$2" expected_gid="$3" expected_mode="$4"
    local uid gid mode links identity
    [[ -f "$target" && ! -L "$target" ]] || return 1
    read -r uid gid mode links identity <<< "$(file_metadata "$target")"
    [[ "$uid" = "$expected_uid" && "$gid" = "$expected_gid" \
        && "$mode" = "$expected_mode" && "$links" = 1 ]]
}

canonical_path() {
    readlink -f -- "$1" 2>/dev/null || realpath "$1"
}

assert_trusted_path_chain() {
    local target="$1" trusted_root="$2" expected_uid="$3" current
    [[ "$target" = "$trusted_root" || "$target" = "$trusted_root"/* ]] || return 1
    current="$target"
    while :; do
        assert_trusted_directory "$current" "$expected_uid" \
            && [[ "$(canonical_path "$current")" = "$current" ]] || return 1
        [[ "$current" = "$trusted_root" ]] && return 0
        current=$(dirname "$current")
    done
}

assert_binary() {
    local resolved uid gid mode links identity mode_value
    [[ "$postgrest_binary" = /* && -x "$postgrest_binary" && ! -L "$postgrest_binary" ]] || return 1
    resolved=$(canonical_path "$postgrest_binary")
    [[ "$resolved" = "$postgrest_binary" ]] || return 1
    assert_trusted_path_chain "$(dirname "$postgrest_binary")" "$binary_trust_root" "$control_uid" \
        || return 1
    read -r uid gid mode links identity <<< "$(file_metadata "$postgrest_binary")"
    mode_value=$((8#$mode))
    [[ "$uid" = "$control_uid" && "$links" = 1 && $((mode_value & 8#7022)) -eq 0 ]]
}

if ! { [[ "$(canonical_path "$config_trust_root")" = "$config_trust_root" \
        && "$(canonical_path "$binary_trust_root")" = "$binary_trust_root" ]] \
        && assert_trusted_path_chain "$config_root" "$config_trust_root" "$control_uid" \
        && assert_control_root "$config_root" "$control_uid"; }; then
    echo "ERROR: Unsafe PostgREST tenant configuration root" >&2
    exit 1
fi
[[ "$(canonical_path "$config_root")" = "$config_root" ]] || {
    echo "ERROR: PostgREST tenant configuration root is not canonical" >&2
    exit 1
}
assert_binary || {
    echo "ERROR: Unsafe PostgREST binary" >&2
    exit 1
}

pointer_path="${config_root}/${project_ref}_postgrest.current"
legacy_path="${config_root}/${project_ref}.conf"
config_path=""

if [[ -e "$pointer_path" || -L "$pointer_path" ]]; then
    assert_regular_file "$pointer_path" "$control_uid" "$runtime_gid" 440 || {
        echo "ERROR: Unsafe PostgREST generation pointer" >&2
        exit 1
    }
    pointer_identity_before=$(file_metadata "$pointer_path")
    pointer_bytes=$(wc -c < "$pointer_path")
    IFS= read -r pointer_target < "$pointer_path" || {
        echo "ERROR: Empty PostgREST generation pointer" >&2
        exit 1
    }
    [[ "$pointer_target" =~ ^${project_ref}_postgrest\.d/[a-f0-9]{64}\.conf$ \
        && "$pointer_bytes" -eq $((${#pointer_target} + 1)) ]] || {
        echo "ERROR: Invalid PostgREST generation pointer" >&2
        exit 1
    }
    [[ "$(file_metadata "$pointer_path")" = "$pointer_identity_before" ]] || {
        echo "ERROR: PostgREST generation pointer changed while loading" >&2
        exit 1
    }

    generation_directory="${config_root}/${project_ref}_postgrest.d"
    config_path="${config_root}/${pointer_target}"
    assert_directory "$generation_directory" "$control_uid" "$runtime_gid" 750 \
        && [[ "$(canonical_path "$generation_directory")" = "$generation_directory" ]] \
        && assert_regular_file "$config_path" "$control_uid" "$runtime_gid" 440 \
        && [[ "$(canonical_path "$config_path")" = "$config_path" ]] || {
        echo "ERROR: Unsafe PostgREST generation" >&2
        exit 1
    }
elif [[ -e "$legacy_path" || -L "$legacy_path" ]]; then
    assert_regular_file "$legacy_path" "$runtime_uid" "$runtime_gid" 600 \
        && [[ "$(canonical_path "$legacy_path")" = "$legacy_path" ]] || {
        echo "ERROR: Unsafe legacy PostgREST configuration" >&2
        exit 1
    }
    config_path="$legacy_path"
else
    echo "ERROR: PostgREST configuration is unavailable" >&2
    exit 1
fi

# Postrust v3.4.0 reads environment variables and has no config-file argument.
# The trusted per-tenant file stays the write contract; this launcher is the
# only place that turns it into Postrust's environment. Haskell +RTS flags from
# existing units are ignored. PGRST_COMPAT_MODE stays on so project REST paths
# and RPC bodies stay PostgREST-shaped.
postrust_env_name_for_key() {
    case "$1" in
        db-uri) printf 'PGRST_DB_URI' ;;
        db-schemas) printf 'PGRST_DB_SCHEMAS' ;;
        db-extra-search-path) printf 'PGRST_DB_EXTRA_SEARCH_PATH' ;;
        db-anon-role) printf 'PGRST_DB_ANON_ROLE' ;;
        jwt-secret) printf 'PGRST_JWT_SECRET' ;;
        jwt-aud) printf 'PGRST_JWT_AUD' ;;
        server-port) printf 'PGRST_SERVER_PORT' ;;
        server-host) printf 'PGRST_SERVER_HOST' ;;
        db-pool) printf 'PGRST_DB_POOL' ;;
        db-pool-acquisition-timeout) printf 'PGRST_DB_POOL_TIMEOUT' ;;
        log-level) printf 'PGRST_LOG_LEVEL' ;;
        openapi-mode) printf 'PGRST_OPENAPI_MODE' ;;
        openapi-server-proxy-uri) printf 'PGRST_OPENAPI_SERVER_PROXY_URI' ;;
        db-pre-request) printf 'PGRST_DB_PRE_REQUEST' ;;
        db-max-rows) printf 'PGRST_DB_MAX_ROWS' ;;
        server-cors-allowed-origins) printf 'PGRST_SERVER_CORS_ORIGINS' ;;
        db-channel) printf 'PGRST_DB_CHANNEL' ;;
        db-channel-enabled) printf 'PGRST_DB_CHANNEL_ENABLED' ;;
        *) return 1 ;;
    esac
}

postrust_decode_config_value() {
    local raw="$1" inner="" out="" hex="" decoded="" char=""
    local backslash quote slash
    local -i index=0 length=0
    printf -v backslash '\134'
    quote='"'
    slash='/'
    if [[ "$raw" =~ ^\"(.*)\"$ ]]; then
        inner="${BASH_REMATCH[1]}"
        length=${#inner}
        while (( index < length )); do
            char="${inner:index:1}"
            if [[ "$char" != "$backslash" ]]; then
                out+="$char"
                index=$((index + 1))
                continue
            fi
            index=$((index + 1))
            (( index < length )) || return 1
            char="${inner:index:1}"
            if [[ "$char" == "$quote" || "$char" == "$backslash" || "$char" == "$slash" ]]; then
                out+="$char"
            elif [[ "$char" == "b" ]]; then
                out+=$'\b'
            elif [[ "$char" == "f" ]]; then
                out+=$'\f'
            elif [[ "$char" == "n" ]]; then
                out+=$'\n'
            elif [[ "$char" == "r" ]]; then
                out+=$'\r'
            elif [[ "$char" == "t" ]]; then
                out+=$'\t'
            elif [[ "$char" == "u" ]]; then
                hex="${inner:index+1:4}"
                [[ "$hex" =~ ^[0-9a-fA-F]{4}$ ]] || return 1
                printf -v decoded '%b' "\\u${hex}"
                out+="$decoded"
                index=$((index + 4))
            else
                return 1
            fi
            index=$((index + 1))
        done
    elif [[ "$raw" =~ ^[A-Za-z0-9._:+/-]+$ ]]; then
        out="$raw"
    else
        return 1
    fi
    [[ "$out" != *$'\n'* && "$out" != *$'\r'* ]] || return 1
    printf '%s' "$out"
}

postrust_config_assignments=()
postrust_seen_keys=" "
while IFS= read -r postrust_line || [[ -n "$postrust_line" ]]; do
    postrust_line="${postrust_line%$'\r'}"
    [[ -z "${postrust_line//[[:space:]]/}" || "$postrust_line" =~ ^[[:space:]]*# ]] && continue
    [[ "$postrust_line" =~ ^[[:space:]]*([a-z][a-z0-9-]*)[[:space:]]*=[[:space:]]*(.+)$ ]] || {
        echo "ERROR: Invalid Postrust tenant configuration line" >&2
        exit 1
    }
    postrust_key="${BASH_REMATCH[1]}"
    postrust_raw="${BASH_REMATCH[2]}"
    postrust_raw="${postrust_raw%"${postrust_raw##*[![:space:]]}"}"
    [[ "$postrust_seen_keys" != *" ${postrust_key} "* ]] || {
        echo "ERROR: Duplicate Postrust configuration key" >&2
        exit 1
    }
    postrust_env_name=$(postrust_env_name_for_key "$postrust_key") || {
        echo "ERROR: Unsupported Postrust configuration key" >&2
        exit 1
    }
    postrust_value=$(postrust_decode_config_value "$postrust_raw") || {
        echo "ERROR: Invalid Postrust configuration value" >&2
        exit 1
    }
    postrust_seen_keys+="${postrust_key} "
    postrust_config_assignments+=("${postrust_env_name}=${postrust_value}")
done < "$config_path"

if [[ "$postrust_seen_keys" == *" db-channel "* && "$postrust_seen_keys" != *" db-channel-enabled "* ]]; then
    postrust_config_assignments+=("PGRST_DB_CHANNEL_ENABLED=true")
fi
postrust_config_assignments+=("PGRST_COMPAT_MODE=true")

while [[ $# -gt 0 ]]; do
    if [[ "$1" == "+RTS" ]]; then
        shift
        postrust_closed_rts=false
        while [[ $# -gt 0 ]]; do
            if [[ "$1" == "-RTS" ]]; then
                postrust_closed_rts=true
                shift
                break
            fi
            shift
        done
        [[ "$postrust_closed_rts" == true ]] || {
            echo "ERROR: Unclosed Haskell RTS block" >&2
            exit 1
        }
        continue
    fi
    echo "ERROR: Postrust does not accept launcher arguments" >&2
    exit 1
done

exec /usr/bin/env -i "${postrust_config_assignments[@]}" "$postgrest_binary"

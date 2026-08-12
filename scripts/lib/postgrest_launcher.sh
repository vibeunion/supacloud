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

exec /usr/bin/env -i "$postgrest_binary" "$config_path" "$@"

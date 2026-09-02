#!/usr/bin/env bash

SUPACLOUD_POSTGREST_DEFAULT_VERSION="v16.2"
SUPACLOUD_POSTGREST_X86_64_SHA256="4712595baae0f5d84a527d55a11166d6bf4d9b0f1d102505c5e9d59219787f08"
SUPACLOUD_POSTGREST_ARM64_SHA256="4c83974272acb56e6091e969ba4ee345fbc053cde457b0c8a9399e0d2a12c32d"

supacloud_postgrest_binary_version() {
    local binary_path="$1"
    local version
    [[ -x "$binary_path" ]] || return 1
    version=$("$binary_path" --version 2>/dev/null | head -1) || return 1
    version="${version#PostgREST }"
    version="${version#v}"
    [[ "$version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?([+-][A-Za-z0-9._-]+)?$ ]] || return 1
    printf 'v%s' "$version"
}

supacloud_resolve_postgrest_release() {
    local target_version="$1"
    local machine
    [[ "$target_version" =~ ^v[0-9]+\.[0-9]+(\.[0-9]+)?([+-][A-Za-z0-9._-]+)?$ ]] || {
        printf 'Invalid PostgREST version (expected v-prefixed release): %s\n' "$target_version" >&2
        return 1
    }
    machine=$(uname -m)
    case "$machine" in
        x86_64|amd64)
            SUPACLOUD_POSTGREST_RELEASE_ARCH="linux-static-x86-64"
            SUPACLOUD_POSTGREST_VALIDATION_ARCH="amd64"
            SUPACLOUD_POSTGREST_RELEASE_SHA256="$SUPACLOUD_POSTGREST_X86_64_SHA256"
            ;;
        aarch64|arm64)
            SUPACLOUD_POSTGREST_RELEASE_ARCH="linux-static-aarch64"
            SUPACLOUD_POSTGREST_VALIDATION_ARCH="arm64"
            SUPACLOUD_POSTGREST_RELEASE_SHA256="$SUPACLOUD_POSTGREST_ARM64_SHA256"
            ;;
        *)
            printf 'Unsupported architecture for PostgREST: %s\n' "$machine" >&2
            return 1
            ;;
    esac
    if [[ "$target_version" != "$SUPACLOUD_POSTGREST_DEFAULT_VERSION" ]]; then
        SUPACLOUD_POSTGREST_RELEASE_SHA256="${POSTGREST_SHA256:-}"
    else
        SUPACLOUD_POSTGREST_RELEASE_SHA256="${POSTGREST_SHA256:-$SUPACLOUD_POSTGREST_RELEASE_SHA256}"
    fi
    [[ "$SUPACLOUD_POSTGREST_RELEASE_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || {
        printf 'POSTGREST_SHA256 is required for unpinned PostgREST version %s\n' "$target_version" >&2
        return 1
    }
    SUPACLOUD_POSTGREST_RELEASE_ASSET="postgrest-${target_version}-${SUPACLOUD_POSTGREST_RELEASE_ARCH}.tar.xz"
    SUPACLOUD_POSTGREST_RELEASE_URL="https://github.com/PostgREST/postgrest/releases/download/${target_version}/${SUPACLOUD_POSTGREST_RELEASE_ASSET}"
}

supacloud_postgrest_active_units() {
    local unit units
    units=$(systemctl list-units --type=service --state=running --no-legend --no-pager 'supacloud-pgrst@*.service') || return 1
    while read -r unit _; do
        [[ "$unit" =~ ^supacloud-pgrst@[a-z0-9-]{1,20}\.service$ ]] || continue
        printf '%s\n' "$unit"
    done <<< "$units"
}

supacloud_postgrest_unit_ref() {
    local unit="$1"
    local ref="${unit#supacloud-pgrst@}"
    ref="${ref%.service}"
    [[ "$ref" =~ ^[a-z0-9-]{1,20}$ ]] || return 1
    printf '%s' "$ref"
}

supacloud_postgrest_unit_port() {
    local unit="$1"
    local tenant_dir="${SUPACLOUD_POSTGREST_TENANT_CONFIG_DIR:-/etc/supabase/tenants}"
    local ref port
    ref=$(supacloud_postgrest_unit_ref "$unit") || return 1
    port=$(supacloud_env_value "${tenant_dir}/${ref}.env" SUPACLOUD_INTERNAL_POSTGREST_PORT) || return 1
    if [[ -z "$port" ]]; then
        port=$(supacloud_env_value "${tenant_dir}/${ref}.env" PGRST_SERVER_PORT) || return 1
    fi
    [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || return 1
    printf '%s' "$port"
}

supacloud_postgrest_unit_uses_binary() {
    local unit="$1"
    local binary_path="$2"
    local pid running_identity target_identity
    pid=$(systemctl show --property=MainPID --value "$unit") || return 1
    [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
    running_identity=$(stat -Lc '%d:%i' "/proc/${pid}/exe") || return 1
    target_identity=$(stat -Lc '%d:%i' "$binary_path") || return 1
    [[ "$running_identity" == "$target_identity" ]]
}

supacloud_postgrest_unit_is_attested() {
    local unit="$1"
    local binary_path="$2"
    local expected_version="$3"
    local port
    [[ "$(supacloud_postgrest_binary_version "$binary_path" 2>/dev/null || true)" == "$expected_version" ]] || return 1
    systemctl is-active --quiet "$unit" || return 1
    supacloud_postgrest_unit_uses_binary "$unit" "$binary_path" || return 1
    port=$(supacloud_postgrest_unit_port "$unit") || return 1
    curl -fsS "http://127.0.0.1:${port}/" >/dev/null 2>&1
}

supacloud_wait_postgrest_unit_version() {
    local unit="$1"
    local binary_path="$2"
    local expected_version="$3"
    local attempts="${SUPACLOUD_POSTGREST_HEALTH_ATTEMPTS:-30}"
    local delay_seconds="${SUPACLOUD_POSTGREST_HEALTH_DELAY_SECONDS:-1}"
    local attempt
    for ((attempt = 1; attempt <= attempts; attempt++)); do
        if supacloud_postgrest_unit_is_attested "$unit" "$binary_path" "$expected_version"; then
            return 0
        fi
        sleep "$delay_seconds"
    done
    printf 'PostgREST runtime attestation failed for %s at version %s\n' "$unit" "$expected_version" >&2
    return 1
}

supacloud_postgrest_units_are_attested() {
    local units_file="$1"
    local binary_path="$2"
    local expected_version="$3"
    local unit
    while IFS= read -r unit; do
        [[ -n "$unit" ]] || continue
        supacloud_postgrest_unit_is_attested "$unit" "$binary_path" "$expected_version" || return 1
    done < "$units_file"
}

supacloud_restart_postgrest_units() {
    local units_file="$1"
    local binary_path="$2"
    local expected_version="$3"
    local unit
    while IFS= read -r unit; do
        [[ -n "$unit" ]] || continue
        systemctl start "$unit" || return 1
    done < "$units_file"
    while IFS= read -r unit; do
        [[ -n "$unit" ]] || continue
        supacloud_wait_postgrest_unit_version "$unit" "$binary_path" "$expected_version" || return 1
    done < "$units_file"
}

supacloud_stop_postgrest_units() {
    local units_file="$1"
    local stopped_file="$2"
    local unit
    : > "$stopped_file"
    chmod 600 "$stopped_file"
    while IFS= read -r unit; do
        [[ -n "$unit" ]] || continue
        systemctl stop "$unit" || return 1
        printf '%s\n' "$unit" >> "$stopped_file"
    done < "$units_file"
}

supacloud_rollback_postgrest_upgrade() {
    local binary_path="$1"
    local backup_dir="$2"
    local units_file="$3"
    local previous_version="$4"
    local unit
    while IFS= read -r unit; do
        [[ -n "$unit" ]] && systemctl stop "$unit" >/dev/null 2>&1 || true
    done < "$units_file"
    supacloud_restore_file_snapshot "$binary_path" "${backup_dir}/binary" || return 1
    systemctl daemon-reload || return 1
    [[ -z "$previous_version" ]] || supacloud_restart_postgrest_units "$units_file" "$binary_path" "$previous_version"
}

supacloud_upgrade_postgrest_binary_transaction() (
    local binary_path="$1"
    local result_file="$2"
    local target_version="${POSTGREST_VERSION:-$SUPACLOUD_POSTGREST_DEFAULT_VERSION}"
    local current_version="" transaction_dir archive staged_binary="" backup_dir active_units stopped_units status=0
    local binary_requires_upgrade=false

    [[ "$target_version" =~ ^v[0-9]+\.[0-9]+(\.[0-9]+)?([+-][A-Za-z0-9._-]+)?$ ]] || {
        printf 'Invalid PostgREST version (expected v-prefixed release): %s\n' "$target_version" >&2
        return 1
    }
    if [[ -e "$binary_path" ]]; then
        [[ -f "$binary_path" && ! -L "$binary_path" ]] || {
            printf 'Existing PostgREST target must be a regular file: %s\n' "$binary_path" >&2
            return 1
        }
        current_version=$(supacloud_postgrest_binary_version "$binary_path") || {
            printf 'Unable to read the existing PostgREST version from %s\n' "$binary_path" >&2
            return 1
        }
    fi
    if [[ "$current_version" != "$target_version" ]]; then
        binary_requires_upgrade=true
        supacloud_resolve_postgrest_release "$target_version" || return 1
    fi

    transaction_dir=$(mktemp -d "${TMPDIR:-/tmp}/supacloud-postgrest-upgrade.XXXXXX") || return 1
    chmod 700 "$transaction_dir"
    active_units="${transaction_dir}/active-units"
    stopped_units="${transaction_dir}/stopped-units"
    trap 'rm -rf -- "${transaction_dir:-}"; [[ -z "${staged_binary:-}" ]] || rm -f -- "$staged_binary"' EXIT HUP INT TERM
    supacloud_postgrest_active_units > "$active_units" || return 1
    chmod 600 "$active_units"

    if [[ "$binary_requires_upgrade" == false ]] \
        && supacloud_postgrest_units_are_attested "$active_units" "$binary_path" "$target_version"; then
        return 0
    fi

    if [[ "$binary_requires_upgrade" == true ]]; then
        archive="${transaction_dir}/${SUPACLOUD_POSTGREST_RELEASE_ASSET}"
        staged_binary="${binary_path}.staged.$$"
        supacloud_download_url "$SUPACLOUD_POSTGREST_RELEASE_URL" "$archive" || return 1
        supacloud_install_pinned_tar_xz_binary "$archive" postgrest "$SUPACLOUD_POSTGREST_RELEASE_SHA256" \
            "$SUPACLOUD_POSTGREST_VALIDATION_ARCH" "$staged_binary" || return 1
        [[ "$(supacloud_postgrest_binary_version "$staged_binary")" == "$target_version" ]] || {
            printf 'Staged PostgREST binary version does not match %s\n' "$target_version" >&2
            return 1
        }
    fi

    mkdir -p "${SUPACLOUD_POSTGREST_BACKUP_ROOT:-/var/lib/supacloud/backups/postgrest}" || return 1
    chmod 700 "${SUPACLOUD_POSTGREST_BACKUP_ROOT:-/var/lib/supacloud/backups/postgrest}" || return 1
    backup_dir=$(mktemp -d "${SUPACLOUD_POSTGREST_BACKUP_ROOT:-/var/lib/supacloud/backups/postgrest}/${target_version}-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX") || return 1
    supacloud_capture_file_snapshot "$binary_path" "${backup_dir}/binary" || return 1

    if ! supacloud_stop_postgrest_units "$active_units" "$stopped_units"; then
        [[ -z "$current_version" ]] || supacloud_restart_postgrest_units "$stopped_units" "$binary_path" "$current_version" || true
        return 1
    fi

    if [[ "$binary_requires_upgrade" == true ]]; then
        mkdir -p "$(dirname "$binary_path")"
        if mv -f "$staged_binary" "$binary_path"; then
            staged_binary=""
        else
            status=$?
        fi
    fi
    if (( status == 0 )); then chmod 755 "$binary_path" || status=$?; fi
    if (( status == 0 )) && [[ "$(supacloud_postgrest_binary_version "$binary_path" 2>/dev/null || true)" != "$target_version" ]]; then
        status=1
    fi
    if (( status == 0 )); then systemctl daemon-reload || status=$?; fi
    if (( status == 0 )); then supacloud_restart_postgrest_units "$active_units" "$binary_path" "$target_version" || status=$?; fi
    if (( status != 0 )); then
        supacloud_rollback_postgrest_upgrade "$binary_path" "$backup_dir" "$active_units" "$current_version" || {
            printf 'PostgREST rollback failed; recovery backup: %s\n' "$backup_dir" >&2
            return 1
        }
        printf 'PostgREST upgrade failed and the previous runtime was restored\n' >&2
        return "$status"
    fi
    printf '%s' "$backup_dir" > "$result_file"
)

supacloud_upgrade_postgrest_binary() {
    local binary_path="${1:-/usr/local/bin/postgrest}"
    local result_file
    result_file=$(mktemp "${TMPDIR:-/tmp}/supacloud-postgrest-result.XXXXXX") || return 1
    chmod 600 "$result_file"
    if ! supacloud_upgrade_postgrest_binary_transaction "$binary_path" "$result_file"; then
        rm -f "$result_file"
        return 1
    fi
    if [[ -s "$result_file" ]]; then
        SUPACLOUD_POSTGREST_LAST_BACKUP_DIR=$(<"$result_file")
        export SUPACLOUD_POSTGREST_LAST_BACKUP_DIR
    else
        unset SUPACLOUD_POSTGREST_LAST_BACKUP_DIR
    fi
    rm -f "$result_file"
}

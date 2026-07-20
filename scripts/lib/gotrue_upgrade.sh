#!/usr/bin/env bash

SUPACLOUD_GOTRUE_DEFAULT_VERSION="v2.193.0"
SUPACLOUD_GOTRUE_AMD64_SHA256="c991b6fb8747bbcbcef40701177234f152cea28a108a481bae917bacc1a522c5"
SUPACLOUD_GOTRUE_ARM64_SHA256="432fa68ef58afac8665d45537d8adbba5756b01829f175ed7ef6314b3ca59995"

supacloud_gotrue_binary_version() {
    local binary_path="$1"
    local version
    [[ -x "$binary_path" ]] || return 1
    version=$("$binary_path" version 2>/dev/null | head -1) || return 1
    [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9._-]+)?$ ]] || return 1
    printf '%s' "$version"
}

supacloud_resolve_gotrue_release() {
    local target_version="$1"
    local machine
    [[ "$target_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9._-]+)?$ ]] || {
        printf 'Invalid GoTrue version: %s\n' "$target_version" >&2
        return 1
    }
    machine=$(uname -m)
    case "$machine" in
        x86_64|amd64)
            SUPACLOUD_GOTRUE_RELEASE_ARCH="amd64"
            SUPACLOUD_GOTRUE_RELEASE_SHA256="$SUPACLOUD_GOTRUE_AMD64_SHA256"
            ;;
        aarch64|arm64)
            SUPACLOUD_GOTRUE_RELEASE_ARCH="arm64"
            SUPACLOUD_GOTRUE_RELEASE_SHA256="$SUPACLOUD_GOTRUE_ARM64_SHA256"
            ;;
        *)
            printf 'Unsupported architecture for GoTrue: %s\n' "$machine" >&2
            return 1
            ;;
    esac
    if [[ "$target_version" != "$SUPACLOUD_GOTRUE_DEFAULT_VERSION" ]]; then
        SUPACLOUD_GOTRUE_RELEASE_SHA256="${GOTRUE_SHA256:-}"
    else
        SUPACLOUD_GOTRUE_RELEASE_SHA256="${GOTRUE_SHA256:-$SUPACLOUD_GOTRUE_RELEASE_SHA256}"
    fi
    [[ "$SUPACLOUD_GOTRUE_RELEASE_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || {
        printf 'GOTRUE_SHA256 is required for unpinned GoTrue version %s\n' "$target_version" >&2
        return 1
    }
    SUPACLOUD_GOTRUE_RELEASE_ASSET="auth-${target_version}-${SUPACLOUD_GOTRUE_RELEASE_ARCH}.tar.xz"
    SUPACLOUD_GOTRUE_RELEASE_URL="https://github.com/supabase/auth/releases/download/${target_version}/${SUPACLOUD_GOTRUE_RELEASE_ASSET}"
}

supacloud_gotrue_active_units() {
    local unit units
    units=$(systemctl list-units --type=service --state=running --no-legend --no-pager 'supacloud-gotrue@*.service') || return 1
    while read -r unit _; do
        [[ "$unit" =~ ^supacloud-gotrue@[a-z0-9-]{1,20}\.service$ ]] || continue
        printf '%s\n' "$unit"
    done <<< "$units"
}

supacloud_gotrue_database_backup() {
    local backup_dir="$1"
    local host="${SUPACLOUD_GOTRUE_PGHOST:-127.0.0.1}"
    local port="${SUPACLOUD_GOTRUE_PGPORT:-5432}"
    local user="${SUPACLOUD_GOTRUE_PGUSER:-postgres}"
    local password="${POSTGRES_PASSWORD:-${PGPASSWORD:-}}"
    local database auth_schema projects_table
    local databases
    databases=$(PGPASSWORD="$password" psql -X -qAt -h "$host" -p "$port" -U "$user" -d postgres \
        -c "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname") || return 1
    while IFS= read -r database; do
        [[ -n "$database" ]] || continue
        [[ "$database" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
        auth_schema=$(PGPASSWORD="$password" psql -X -qAt -h "$host" -p "$port" -U "$user" -d "$database" \
            -c "SELECT to_regnamespace('auth') IS NOT NULL") || return 1
        [[ "$auth_schema" == "t" ]] || continue
        PGPASSWORD="$password" pg_dump -h "$host" -p "$port" -U "$user" -d "$database" \
            --schema=auth --format=custom --file="${backup_dir}/auth-${database}.dump" || return 1
    done <<< "$databases"

    if grep -Fxq supacloud_meta <<< "$databases"; then
        projects_table=$(PGPASSWORD="$password" psql -X -qAt -h "$host" -p "$port" -U "$user" -d supacloud_meta \
            -c "SELECT to_regclass('public.projects') IS NOT NULL") || return 1
        if [[ "$projects_table" == "t" ]]; then
            PGPASSWORD="$password" pg_dump -h "$host" -p "$port" -U "$user" -d supacloud_meta \
                --table=public.projects --data-only --format=custom \
                --file="${backup_dir}/project-config.dump" || return 1
        fi
    fi
}

supacloud_gotrue_config_inventory() {
    local source_dir="$1"
    local output_file="$2"
    python3 - "$source_dir" "$output_file" <<'PY'
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
output = Path(sys.argv[2])
os.umask(0o077)
inventory = []
if root.exists():
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in sorted(directories + files):
            path = current_path / name
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                raise SystemExit(f"tenant config contains a symbolic link: {path}")
            entry = {
                "path": str(path.relative_to(root)),
                "mode": oct(stat.S_IMODE(metadata.st_mode)),
                "size": metadata.st_size,
                "type": "directory" if path.is_dir() else "file",
            }
            if path.is_file():
                entry["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            inventory.append(entry)
output.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
    chmod 600 "$output_file"
}

supacloud_backup_gotrue_upgrade() (
    umask 077
    local backup_dir="$1"
    local binary_path="$2"
    local tenant_dir="${SUPACLOUD_GOTRUE_TENANT_CONFIG_DIR:-/etc/supabase/tenants}"
    local unit_path="${SUPACLOUD_GOTRUE_UNIT_PATH:-/etc/systemd/system/supacloud-gotrue@.service}"
    local caddy_path="${CADDY_CONFIG_PATH:-/etc/supacloud/caddy/config.json}"
    mkdir -p "$backup_dir"
    chmod 700 "$backup_dir"
    supacloud_capture_file_snapshot "$binary_path" "${backup_dir}/binary" || return 1
    supacloud_capture_file_snapshot "$unit_path" "${backup_dir}/unit" || return 1
    supacloud_capture_file_snapshot "$caddy_path" "${backup_dir}/routes" || return 1
    mkdir -p "${backup_dir}/tenant-config"
    chmod 700 "${backup_dir}/tenant-config"
    if [[ -d "$tenant_dir" ]]; then
        supacloud_gotrue_config_inventory "$tenant_dir" "${backup_dir}/secret-inventory.json" || return 1
        cp -a "${tenant_dir}/." "${backup_dir}/tenant-config/" || return 1
    else
        printf '[]\n' > "${backup_dir}/secret-inventory.json"
        chmod 600 "${backup_dir}/secret-inventory.json"
    fi
    supacloud_gotrue_database_backup "$backup_dir"
)

supacloud_gotrue_unit_ref() {
    local unit="$1"
    local ref="${unit#supacloud-gotrue@}"
    ref="${ref%.service}"
    [[ "$ref" =~ ^[a-z0-9-]{1,20}$ ]] || return 1
    printf '%s' "$ref"
}

supacloud_gotrue_health_version() {
    local unit="$1"
    local tenant_dir="${SUPACLOUD_GOTRUE_TENANT_CONFIG_DIR:-/etc/supabase/tenants}"
    local ref port response
    ref=$(supacloud_gotrue_unit_ref "$unit") || return 1
    port=$(supacloud_env_value "${tenant_dir}/${ref}_gotrue.env" GOTRUE_API_PORT) || return 1
    [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || return 1
    response=$(curl -fsS "http://127.0.0.1:${port}/health") || return 1
    python3 -c 'import json,sys; value=json.load(sys.stdin).get("version"); print(value if isinstance(value,str) else "", end="")' <<< "$response"
}

supacloud_wait_gotrue_unit_version() {
    local unit="$1"
    local expected_version="$2"
    local attempts="${SUPACLOUD_GOTRUE_HEALTH_ATTEMPTS:-30}"
    local delay_seconds="${SUPACLOUD_GOTRUE_HEALTH_DELAY_SECONDS:-1}"
    local attempt version
    for ((attempt = 1; attempt <= attempts; attempt++)); do
        version=$(supacloud_gotrue_health_version "$unit" 2>/dev/null || true)
        [[ "$version" == "$expected_version" ]] && return 0
        sleep "$delay_seconds"
    done
    printf 'GoTrue health version mismatch for %s: expected %s, got %s\n' "$unit" "$expected_version" "${version:-unavailable}" >&2
    return 1
}

supacloud_restart_gotrue_units() {
    local units_file="$1"
    local expected_version="$2"
    local unit
    while IFS= read -r unit; do
        [[ -n "$unit" ]] || continue
        systemctl start "$unit" || return 1
    done < "$units_file"
    while IFS= read -r unit; do
        [[ -n "$unit" ]] || continue
        supacloud_wait_gotrue_unit_version "$unit" "$expected_version" || return 1
    done < "$units_file"
}

supacloud_stop_gotrue_units() {
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

supacloud_rollback_gotrue_upgrade() {
    local binary_path="$1"
    local backup_dir="$2"
    local units_file="$3"
    local previous_version="$4"
    local unit_path="${SUPACLOUD_GOTRUE_UNIT_PATH:-/etc/systemd/system/supacloud-gotrue@.service}"
    local unit
    while IFS= read -r unit; do
        [[ -n "$unit" ]] && systemctl stop "$unit" >/dev/null 2>&1 || true
    done < "$units_file"
    supacloud_restore_file_snapshot "$binary_path" "${backup_dir}/binary" || return 1
    supacloud_restore_file_snapshot "$unit_path" "${backup_dir}/unit" || return 1
    systemctl daemon-reload || return 1
    [[ -z "$previous_version" ]] || supacloud_restart_gotrue_units "$units_file" "$previous_version"
}

supacloud_upgrade_gotrue_binary_transaction() (
    local binary_path="$1"
    local result_file="$2"
    local target_version="${GOTRUE_VERSION:-$SUPACLOUD_GOTRUE_DEFAULT_VERSION}"
    local current_version="" transaction_dir archive staged_binary backup_dir active_units stopped_units status=0
    if [[ -e "$binary_path" ]]; then
        [[ -f "$binary_path" && ! -L "$binary_path" ]] || {
            printf 'Existing GoTrue target must be a regular file: %s\n' "$binary_path" >&2
            return 1
        }
        current_version=$(supacloud_gotrue_binary_version "$binary_path") || {
            printf 'Unable to read the existing GoTrue version from %s\n' "$binary_path" >&2
            return 1
        }
    fi
    [[ "$current_version" != "$target_version" ]] || return 0
    supacloud_resolve_gotrue_release "$target_version" || return 1

    transaction_dir=$(mktemp -d "${TMPDIR:-/tmp}/supacloud-gotrue-upgrade.XXXXXX") || return 1
    chmod 700 "$transaction_dir"
    archive="${transaction_dir}/${SUPACLOUD_GOTRUE_RELEASE_ASSET}"
    staged_binary="${binary_path}.staged.$$"
    active_units="${transaction_dir}/active-units"
    stopped_units="${transaction_dir}/stopped-units"
    trap 'rm -rf -- "${transaction_dir:-}"; [[ -z "${staged_binary:-}" ]] || rm -f -- "$staged_binary"' EXIT HUP INT TERM

    supacloud_download_url "$SUPACLOUD_GOTRUE_RELEASE_URL" "$archive" || return 1
    supacloud_install_pinned_tar_xz_binary "$archive" auth "$SUPACLOUD_GOTRUE_RELEASE_SHA256" \
        "$SUPACLOUD_GOTRUE_RELEASE_ARCH" "$staged_binary" || return 1
    [[ "$(supacloud_gotrue_binary_version "$staged_binary")" == "$target_version" ]] || {
        printf 'Staged GoTrue binary version does not match %s\n' "$target_version" >&2
        return 1
    }

    mkdir -p "${SUPACLOUD_GOTRUE_BACKUP_ROOT:-/var/lib/supacloud/backups/gotrue}" || return 1
    chmod 700 "${SUPACLOUD_GOTRUE_BACKUP_ROOT:-/var/lib/supacloud/backups/gotrue}" || return 1
    backup_dir=$(mktemp -d "${SUPACLOUD_GOTRUE_BACKUP_ROOT:-/var/lib/supacloud/backups/gotrue}/${target_version}-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX") || return 1
    supacloud_gotrue_active_units > "$active_units" || return 1
    chmod 600 "$active_units"
    if ! supacloud_stop_gotrue_units "$active_units" "$stopped_units"; then
        [[ -z "$current_version" ]] || supacloud_restart_gotrue_units "$stopped_units" "$current_version" || true
        return 1
    fi
    if ! supacloud_backup_gotrue_upgrade "$backup_dir" "$binary_path"; then
        [[ -z "$current_version" ]] || supacloud_restart_gotrue_units "$active_units" "$current_version" || true
        return 1
    fi

    mkdir -p "$(dirname "$binary_path")"
    if mv -f "$staged_binary" "$binary_path"; then
        staged_binary=""
    else
        status=$?
    fi
    if (( status == 0 )); then chmod 755 "$binary_path" || status=$?; fi
    if (( status == 0 )) && [[ "$(supacloud_gotrue_binary_version "$binary_path" 2>/dev/null || true)" != "$target_version" ]]; then
        status=1
    fi
    if (( status == 0 )); then systemctl daemon-reload || status=$?; fi
    if (( status == 0 )); then supacloud_restart_gotrue_units "$active_units" "$target_version" || status=$?; fi
    if (( status != 0 )); then
        supacloud_rollback_gotrue_upgrade "$binary_path" "$backup_dir" "$active_units" "$current_version" || {
            printf 'GoTrue rollback failed; recovery backup: %s\n' "$backup_dir" >&2
            return 1
        }
        printf 'GoTrue upgrade failed and the previous runtime was restored\n' >&2
        return "$status"
    fi
    printf '%s' "$backup_dir" > "$result_file"
)

supacloud_upgrade_gotrue_binary() {
    local binary_path="${1:-/usr/local/bin/gotrue}"
    local result_file
    result_file=$(mktemp "${TMPDIR:-/tmp}/supacloud-gotrue-result.XXXXXX") || return 1
    chmod 600 "$result_file"
    if ! supacloud_upgrade_gotrue_binary_transaction "$binary_path" "$result_file"; then
        rm -f "$result_file"
        return 1
    fi
    if [[ -s "$result_file" ]]; then
        SUPACLOUD_GOTRUE_LAST_BACKUP_DIR=$(<"$result_file")
        export SUPACLOUD_GOTRUE_LAST_BACKUP_DIR
    else
        unset SUPACLOUD_GOTRUE_LAST_BACKUP_DIR
    fi
    rm -f "$result_file"
}

#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# shellcheck source=install_config.sh
source "${SCRIPT_DIR}/install_config.sh"
# shellcheck source=release_assets.sh
source "${SCRIPT_DIR}/release_assets.sh"
# shellcheck source=gotrue_upgrade.sh
source "${SCRIPT_DIR}/gotrue_upgrade.sh"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

make_gotrue_archive() {
    local version="$1"
    local archive="$2"
    local payload_dir
    payload_dir=$(mktemp -d "${tmp_dir}/payload.XXXXXX")
    printf '#!/bin/sh\n[ "$1" = version ] && printf "%s\\n"\n' "$version" > "${payload_dir}/auth"
    chmod 755 "${payload_dir}/auth"
    printf 'official sibling fixture\n' > "${payload_dir}/gotrue"
    printf 'official sibling fixture\n' > "${payload_dir}/migrations"
    tar -cJf "$archive" -C "$payload_dir" auth gotrue migrations
}

old_binary="${tmp_dir}/gotrue"
good_archive="${tmp_dir}/auth-v2.194.0.tar.xz"
wrong_version_archive="${tmp_dir}/auth-v2.194.1.tar.xz"
make_gotrue_archive v2.194.0 "$good_archive"
make_gotrue_archive v2.194.1 "$wrong_version_archive"
good_checksum=$(sha256sum "$good_archive" | awk '{print $1}')

tenant_dir="${tmp_dir}/tenants"
backup_root="${tmp_dir}/backups"
unit_path="${tmp_dir}/supacloud-gotrue@.service"
caddy_path="${tmp_dir}/caddy.json"
mkdir -p "$tenant_dir"
printf 'GOTRUE_API_PORT=4101\nSECRET=masked-by-inventory\n' > "${tenant_dir}/tenant1_gotrue.env"
chmod 600 "${tenant_dir}/tenant1_gotrue.env"
printf 'ExecStart=%s\n' "$old_binary" > "$unit_path"
printf '{}\n' > "$caddy_path"

write_binary() {
    local version="$1"
    printf '#!/bin/sh\n[ "$1" = version ] && printf "%s\\n"\n' "$version" > "$old_binary"
    chmod 755 "$old_binary"
}

systemctl_log="${tmp_dir}/systemctl.log"
runtime_active=true
systemctl() {
    case "$1" in
        list-units)
            [[ "$runtime_active" == true ]] && printf 'supacloud-gotrue@tenant1.service loaded active running GoTrue\n'
            ;;
        stop)
            printf 'stop %s\n' "$2" >> "$systemctl_log"
            runtime_active=false
            ;;
        start)
            printf 'start %s\n' "$2" >> "$systemctl_log"
            runtime_active=true
            ;;
        daemon-reload)
            printf 'daemon-reload\n' >> "$systemctl_log"
            ;;
        show)
            case "$2" in
                --property=User) printf 'supacloud-tenant1\n' ;;
                --property=Group) printf 'supacloud-tenant1\n' ;;
                *) return 1 ;;
            esac
            ;;
        *) return 1 ;;
    esac
}

curl() {
    local installed
    installed=$("$old_binary" version)
    if [[ "${FORCE_NEW_HEALTH_MISMATCH:-false}" == true && "$installed" == v2.194.0 ]]; then
        printf '{"version":"v9.9.9"}\n'
    else
        printf '{"version":"%s"}\n' "$installed"
    fi
}

psql() {
    local args="$*"
    case "$args" in
        *"SELECT datname FROM pg_database"*) printf 'tenantdb\nsupacloud_meta\n' ;;
        *"-d tenantdb"*"to_regnamespace"*) printf 't\n' ;;
        *"to_regnamespace"*) printf 'f\n' ;;
        *"-d supacloud_meta"*"to_regclass"*) printf 't\n' ;;
        *) return 1 ;;
    esac
}

pg_dump_log="${tmp_dir}/pg-dump.log"
pg_dump() {
    local argument output=""
    printf '%s\n' "$*" >> "$pg_dump_log"
    for argument in "$@"; do
        case "$argument" in --file=*) output=${argument#--file=} ;; esac
    done
    [[ -n "$output" ]] || return 1
    printf 'backup\n' > "$output"
}

supacloud_validate_binary() { return 0; }
download_source="$good_archive"
download_log="${tmp_dir}/download.log"
supacloud_download_url() {
    printf '%s\n' "$1" >> "$download_log"
    cp "$download_source" "$2"
}

export SUPACLOUD_GOTRUE_TENANT_CONFIG_DIR="$tenant_dir"
export SUPACLOUD_GOTRUE_BACKUP_ROOT="$backup_root"
export SUPACLOUD_GOTRUE_UNIT_PATH="$unit_path"
export CADDY_CONFIG_PATH="$caddy_path"
export SUPACLOUD_GOTRUE_HEALTH_ATTEMPTS=1
export SUPACLOUD_GOTRUE_HEALTH_DELAY_SECONDS=0
export GOTRUE_VERSION=v2.194.0
export GOTRUE_SHA256="$good_checksum"
export POSTGRES_PASSWORD=test-only-password

# An existing v2.192 runtime is backed up, atomically upgraded, restarted, and read back through /health.
write_binary v2.192.0
supacloud_upgrade_gotrue_binary "$old_binary"
[[ "$("$old_binary" version)" == v2.194.0 ]]
grep -Fq 'stop supacloud-gotrue@tenant1.service' "$systemctl_log"
grep -Fq 'start supacloud-gotrue@tenant1.service' "$systemctl_log"
grep -Fqx 'User=supacloud-%i' "$unit_path"
grep -Fqx 'Group=supacloud-%i' "$unit_path"
[[ -f "${SUPACLOUD_GOTRUE_LAST_BACKUP_DIR}/auth-tenantdb.dump" ]]
[[ -f "${SUPACLOUD_GOTRUE_LAST_BACKUP_DIR}/project-config.dump" ]]
[[ -f "${SUPACLOUD_GOTRUE_LAST_BACKUP_DIR}/secret-inventory.json" ]]

# A target-version binary still repairs a stale unit inside the same transaction.
: > "$systemctl_log"
: > "$download_log"
printf 'User=nobody\nGroup=nobody\nExecStart=%s\n' "$old_binary" > "$unit_path"
supacloud_upgrade_gotrue_binary "$old_binary"
[[ ! -s "$download_log" ]]
grep -Fq 'stop supacloud-gotrue@tenant1.service' "$systemctl_log"
grep -Fq 'daemon-reload' "$systemctl_log"
grep -Fq 'start supacloud-gotrue@tenant1.service' "$systemctl_log"
grep -Fqx 'User=supacloud-%i' "$unit_path"

# Once both the binary and unit are canonical, the transaction is idempotent.
: > "$systemctl_log"
supacloud_upgrade_gotrue_binary "$old_binary"
[[ ! -s "$systemctl_log" ]]

# A checksum mismatch and a staged version mismatch both leave the old runtime untouched.
write_binary v2.192.0
GOTRUE_SHA256=$(printf '0%.0s' {1..64})
if supacloud_upgrade_gotrue_binary "$old_binary" >/dev/null 2>&1; then
    echo "GoTrue checksum mismatch was accepted" >&2
    exit 1
fi
[[ "$("$old_binary" version)" == v2.192.0 ]]

GOTRUE_SHA256=$(sha256sum "$wrong_version_archive" | awk '{print $1}')
download_source="$wrong_version_archive"
if supacloud_upgrade_gotrue_binary "$old_binary" >/dev/null 2>&1; then
    echo "GoTrue staged version mismatch was accepted" >&2
    exit 1
fi
[[ "$("$old_binary" version)" == v2.192.0 ]]

# A /health version mismatch restores v2.192 and never replays the schema dump.
GOTRUE_SHA256="$good_checksum"
download_source="$good_archive"
FORCE_NEW_HEALTH_MISMATCH=true
printf 'User=nobody\nGroup=nobody\nExecStart=%s\n' "$old_binary" > "$unit_path"
if supacloud_upgrade_gotrue_binary "$old_binary" >/dev/null 2>&1; then
    echo "GoTrue health version mismatch was accepted" >&2
    exit 1
fi
unset FORCE_NEW_HEALTH_MISMATCH
[[ "$("$old_binary" version)" == v2.192.0 ]]
grep -Fqx 'User=nobody' "$unit_path"
if grep -Eq 'pg_restore|DROP[[:space:]]+COLUMN|custom_claims_allowlist' "$pg_dump_log"; then
    echo "GoTrue application rollback attempted to reverse the additive auth migration" >&2
    exit 1
fi

echo "GoTrue staged upgrade checks passed"

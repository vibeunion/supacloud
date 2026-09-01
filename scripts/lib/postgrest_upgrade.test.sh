#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=install_config.sh
source "${SCRIPT_DIR}/install_config.sh"
# shellcheck source=release_assets.sh
source "${SCRIPT_DIR}/release_assets.sh"
# shellcheck source=postgrest_upgrade.sh
source "${SCRIPT_DIR}/postgrest_upgrade.sh"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

make_postgrest_archive() {
    local version="$1"
    local archive="$2"
    local payload_dir
    payload_dir=$(mktemp -d "${tmp_dir}/payload.XXXXXX")
    printf '#!/bin/sh\nprintf "PostgREST %s\\n"\n' "${version#v}" > "${payload_dir}/postgrest"
    chmod 755 "${payload_dir}/postgrest"
    tar -cJf "$archive" -C "$payload_dir" postgrest
}

postgrest_binary="${tmp_dir}/postgrest"
good_archive="${tmp_dir}/postgrest-v16.2.tar.xz"
wrong_version_archive="${tmp_dir}/postgrest-v16.1.tar.xz"
make_postgrest_archive v16.2 "$good_archive"
make_postgrest_archive v16.1 "$wrong_version_archive"
good_checksum=$(sha256sum "$good_archive" | awk '{print $1}')

write_binary() {
    local version="$1"
    printf '#!/bin/sh\nprintf "PostgREST %s\\n"\n' "${version#v}" > "$postgrest_binary"
    chmod 755 "$postgrest_binary"
}

tenant_dir="${tmp_dir}/tenants"
backup_root="${tmp_dir}/backups"
mkdir -p "$tenant_dir"
printf 'SUPACLOUD_INTERNAL_POSTGREST_PORT=3101\n' > "${tenant_dir}/tenant1.env"
chmod 600 "${tenant_dir}/tenant1.env"

systemctl_log="${tmp_dir}/systemctl.log"
runtime_active=true
runtime_binary_current=true
systemctl() {
    case "$1" in
        list-units)
            [[ "$runtime_active" == true ]] && printf 'supacloud-pgrst@tenant1.service loaded active running PostgREST\n'
            ;;
        stop)
            printf 'stop %s\n' "$2" >> "$systemctl_log"
            runtime_active=false
            ;;
        start)
            printf 'start %s\n' "$2" >> "$systemctl_log"
            runtime_active=true
            runtime_binary_current=true
            ;;
        is-active)
            [[ "$runtime_active" == true ]]
            ;;
        daemon-reload)
            printf 'daemon-reload\n' >> "$systemctl_log"
            ;;
        show)
            printf '1234\n'
            ;;
        *) return 1 ;;
    esac
}

curl() {
    [[ "$runtime_active" == true ]]
}

supacloud_postgrest_unit_uses_binary() {
    if [[ "${FORCE_NEW_ATTESTATION_FAILURE:-false}" == true \
        && "$(supacloud_postgrest_binary_version "$postgrest_binary")" == v16.2 ]]; then
        return 1
    fi
    [[ "$runtime_binary_current" == true ]]
}

supacloud_validate_binary() { return 0; }
download_source="$good_archive"
download_log="${tmp_dir}/download.log"
supacloud_download_url() {
    printf '%s\n' "$1" >> "$download_log"
    cp "$download_source" "$2"
}

export SUPACLOUD_POSTGREST_TENANT_CONFIG_DIR="$tenant_dir"
export SUPACLOUD_POSTGREST_BACKUP_ROOT="$backup_root"
export SUPACLOUD_POSTGREST_HEALTH_ATTEMPTS=1
export SUPACLOUD_POSTGREST_HEALTH_DELAY_SECONDS=0
export POSTGREST_VERSION=v16.2
export POSTGREST_SHA256="$good_checksum"

# Every active tenant is stopped, upgraded, restarted, and attested.
write_binary v14.16
supacloud_upgrade_postgrest_binary "$postgrest_binary"
[[ "$(supacloud_postgrest_binary_version "$postgrest_binary")" == v16.2 ]]
grep -Fq 'stop supacloud-pgrst@tenant1.service' "$systemctl_log"
grep -Fq 'daemon-reload' "$systemctl_log"
grep -Fq 'start supacloud-pgrst@tenant1.service' "$systemctl_log"
[[ -f "${SUPACLOUD_POSTGREST_LAST_BACKUP_DIR}/binary/content" ]]

# An already-attested target runtime is a no-op.
: > "$systemctl_log"
: > "$download_log"
supacloud_upgrade_postgrest_binary "$postgrest_binary"
[[ ! -s "$systemctl_log" ]]
[[ ! -s "$download_log" ]]

# A stale process using the replaced binary inode is restarted without downloading.
runtime_binary_current=false
: > "$systemctl_log"
supacloud_upgrade_postgrest_binary "$postgrest_binary"
[[ ! -s "$download_log" ]]
grep -Fq 'stop supacloud-pgrst@tenant1.service' "$systemctl_log"
grep -Fq 'start supacloud-pgrst@tenant1.service' "$systemctl_log"
runtime_binary_current=true

# Release tags without the required v prefix are rejected before mutation.
POSTGREST_VERSION=16.2
if supacloud_upgrade_postgrest_binary "$postgrest_binary" >/dev/null 2>&1; then
    echo "PostgREST accepted a version without the v prefix" >&2
    exit 1
fi
[[ "$(supacloud_postgrest_binary_version "$postgrest_binary")" == v16.2 ]]

# Failed runtime attestation restores the previous binary and restarts it.
POSTGREST_VERSION=v16.2
write_binary v14.16
download_source="$good_archive"
POSTGREST_SHA256="$good_checksum"
FORCE_NEW_ATTESTATION_FAILURE=true
if supacloud_upgrade_postgrest_binary "$postgrest_binary" >/dev/null 2>&1; then
    echo "PostgREST runtime attestation failure was accepted" >&2
    exit 1
fi
unset FORCE_NEW_ATTESTATION_FAILURE
[[ "$(supacloud_postgrest_binary_version "$postgrest_binary")" == v14.16 ]]

# A staged binary with the wrong version never replaces the live binary.
download_source="$wrong_version_archive"
POSTGREST_SHA256=$(sha256sum "$wrong_version_archive" | awk '{print $1}')
if supacloud_upgrade_postgrest_binary "$postgrest_binary" >/dev/null 2>&1; then
    echo "PostgREST staged version mismatch was accepted" >&2
    exit 1
fi
[[ "$(supacloud_postgrest_binary_version "$postgrest_binary")" == v14.16 ]]

echo "PostgREST staged global upgrade checks passed"

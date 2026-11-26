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
    mkdir -p "${payload_dir}/usr/local/bin"
    printf '#!/bin/sh\nprintf "PostgREST %s\\n"\n' "${version#v}" > "${payload_dir}/usr/local/bin/postrust"
    chmod 755 "${payload_dir}/usr/local/bin/postrust"
    tar -czf "$archive" -C "$payload_dir" usr/local/bin/postrust
}

postgrest_binary="${tmp_dir}/postgrest"
good_archive="${tmp_dir}/postgrest-v16.4.tar.xz"
wrong_version_archive="${tmp_dir}/postgrest-v16.1.tar.xz"
make_postgrest_archive v16.4 "$good_archive"
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
            [[ "$runtime_active" == true ]] && printf 'supacloud-postrust@tenant1.service loaded active running PostgREST\n'
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
        && "$(supacloud_postgrest_binary_version "$postgrest_binary")" == v16.4 ]]; then
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
export POSTGREST_VERSION=v16.4
export POSTGREST_SHA256="$good_checksum"

# Every active tenant is stopped, upgraded, restarted, and attested.
write_binary v14.16
supacloud_upgrade_postgrest_binary "$postgrest_binary"
[[ "$(supacloud_postgrest_binary_version "$postgrest_binary")" == v16.4 ]]
grep -Fq 'stop supacloud-postrust@tenant1.service' "$systemctl_log"
grep -Fq 'daemon-reload' "$systemctl_log"
grep -Fq 'start supacloud-postrust@tenant1.service' "$systemctl_log"
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
grep -Fq 'stop supacloud-postrust@tenant1.service' "$systemctl_log"
grep -Fq 'start supacloud-postrust@tenant1.service' "$systemctl_log"
runtime_binary_current=true

# Release tags without the required v prefix are rejected before mutation.
POSTGREST_VERSION=16.2
if supacloud_upgrade_postgrest_binary "$postgrest_binary" >/dev/null 2>&1; then
    echo "PostgREST accepted a version without the v prefix" >&2
    exit 1
fi
[[ "$(supacloud_postgrest_binary_version "$postgrest_binary")" == v16.4 ]]

# Failed runtime attestation restores the previous binary and restarts it.
POSTGREST_VERSION=v16.4
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

# Explicit v3.4.0 is built from source. The default is the temporary layer.
# Neither path downloads the official image.
resolve_err="${tmp_dir}/resolve.err"
if [[ "$(uname -m)" == "x86_64" || "$(uname -m)" == "amd64" ]]; then
    if supacloud_resolve_postgrest_release "$SUPACLOUD_POSTRUST_UPSTREAM_VERSION" >/dev/null 2>"$resolve_err"; then
        echo "v3.4.0 resolved to a download" >&2
        exit 1
    fi
    grep -Fq 'pinned source archive' "$resolve_err"
    grep -Fq 'official image is not installed' "$resolve_err"

    unset POSTGREST_SHA256 POSTRUST_RELEASE_URL POSTRUST_BINARY_SHA256
    supacloud_resolve_postgrest_release "$SUPACLOUD_POSTRUST_TEMPORARY_VERSION"
    [[ "$SUPACLOUD_POSTGREST_RELEASE_URL" == "$SUPACLOUD_POSTRUST_TEMPORARY_LAYER_URL" ]]
    [[ "$SUPACLOUD_POSTGREST_RELEASE_SHA256" == "$SUPACLOUD_POSTRUST_TEMPORARY_LAYER_SHA256" ]]
    [[ "$SUPACLOUD_POSTRUST_BINARY_SHA256" == "$SUPACLOUD_POSTRUST_TEMPORARY_BINARY_SHA256" ]]

    POSTGREST_SHA256="${SUPACLOUD_POSTRUST_UNPATCHED_LAYER_AMD64#sha256:}"
    POSTRUST_BINARY_SHA256="$SUPACLOUD_POSTRUST_UNPATCHED_BINARY_SHA256"
    POSTRUST_RELEASE_URL="https://registry-1.docker.io/v2/postrust/postrust/blobs/${SUPACLOUD_POSTRUST_UNPATCHED_LAYER_AMD64}"
    supacloud_resolve_postgrest_release "$SUPACLOUD_POSTRUST_TEMPORARY_VERSION"
    [[ "$SUPACLOUD_POSTGREST_RELEASE_URL" == "$SUPACLOUD_POSTRUST_TEMPORARY_LAYER_URL" ]]
    [[ "$SUPACLOUD_POSTGREST_RELEASE_SHA256" == "$SUPACLOUD_POSTRUST_TEMPORARY_LAYER_SHA256" ]]
    [[ "$SUPACLOUD_POSTRUST_BINARY_SHA256" == "$SUPACLOUD_POSTRUST_TEMPORARY_BINARY_SHA256" ]]
    unset POSTGREST_SHA256 POSTRUST_RELEASE_URL POSTRUST_BINARY_SHA256

    POSTGREST_SHA256="${SUPACLOUD_POSTRUST_UNPATCHED_LAYER_AMD64#sha256:}"
    POSTRUST_BINARY_SHA256="$SUPACLOUD_POSTRUST_UNPATCHED_BINARY_SHA256"
    if supacloud_resolve_postgrest_release v9.9.9 >/dev/null 2>"$resolve_err"; then
        echo "unpatched official binary digest was accepted" >&2
        exit 1
    fi
    grep -Fq 'refused' "$resolve_err"
    unset POSTGREST_SHA256 POSTRUST_BINARY_SHA256
else
    if supacloud_resolve_postgrest_release "$SUPACLOUD_POSTRUST_TEMPORARY_VERSION" >/dev/null 2>"$resolve_err"; then
        echo "arm64 resolved an amd64-only Postrust layer" >&2
        exit 1
    fi
    grep -Fq 'publishes no official linux/arm64 image' "$resolve_err"
fi

probe_archive="${tmp_dir}/unpatched-probe.tar.gz"
make_postgrest_archive v3.4.0 "$probe_archive"
probe_sha=$(sha256sum "$probe_archive" | awk '{print $1}')
if supacloud_install_pinned_postrust_layer "$probe_archive" usr/local/bin/postrust \
    "$probe_sha" "$SUPACLOUD_POSTRUST_UNPATCHED_BINARY_SHA256" amd64 "${tmp_dir}/refused-binary"; then
    echo "installer accepted the unpatched binary digest" >&2
    exit 1
fi
if supacloud_install_pinned_postrust_layer "$probe_archive" usr/local/bin/postrust \
    "${SUPACLOUD_POSTRUST_UNPATCHED_LAYER_AMD64#sha256:}" "" amd64 "${tmp_dir}/refused-layer"; then
    echo "installer accepted the unpatched layer digest" >&2
    exit 1
fi
if supacloud_install_pinned_postrust_layer "$probe_archive" usr/local/bin/postrust \
    "$SUPACLOUD_POSTRUST_TEMPORARY_LAYER_SHA256" \
    "$SUPACLOUD_POSTRUST_TEMPORARY_BINARY_SHA256" \
    amd64 "${tmp_dir}/refused-temporary"; then
    echo "temporary pin accepted a stand-in archive" >&2
    exit 1
fi

build_count_file="${tmp_dir}/postrust-build-count"
printf '0\n' > "$build_count_file"
supacloud_build_patched_postrust() {
    local target="$1"
    local count
    count=$(<"$build_count_file")
    printf '%s\n' "$((count + 1))" > "$build_count_file"
    printf '#!/bin/sh\nprintf "PostgREST %s\\n"\n' "${SUPACLOUD_POSTRUST_UPSTREAM_VERSION#v}" > "$target"
    chmod 755 "$target"
    printf '%s\n%s\n%s\n%s\n%s\n' \
        "$SUPACLOUD_POSTRUST_PATCH_ID" \
        "$SUPACLOUD_POSTRUST_PATCH_SHA256" \
        "$SUPACLOUD_POSTRUST_SOURCE_SHA256" \
        "$SUPACLOUD_POSTRUST_RUSTC_VERSION" \
        "$SUPACLOUD_POSTRUST_FEATURES" > "${target}.postrust-patch"
    chmod 644 "${target}.postrust-patch"
}

export POSTGREST_VERSION="$SUPACLOUD_POSTRUST_UPSTREAM_VERSION"
unset POSTGREST_SHA256 POSTRUST_RELEASE_URL POSTRUST_BINARY_SHA256
write_binary v14.16
rm -f "${postgrest_binary}.postrust-patch" "${postgrest_binary}.postrust-version"
runtime_active=true
runtime_binary_current=true
: > "$systemctl_log"
: > "$download_log"
supacloud_upgrade_postgrest_binary "$postgrest_binary"
[[ "$(<"$build_count_file")" -eq 1 ]]
[[ "$(supacloud_postgrest_binary_version "$postgrest_binary")" == "$SUPACLOUD_POSTRUST_UPSTREAM_VERSION" ]]
supacloud_postrust_patch_stamp_matches "$postgrest_binary"
[[ ! -s "$download_log" ]]

: > "$systemctl_log"
: > "$download_log"
supacloud_upgrade_postgrest_binary "$postgrest_binary"
[[ "$(<"$build_count_file")" -eq 1 ]]
[[ ! -s "$systemctl_log" ]]
[[ ! -s "$download_log" ]]

rm -f "${postgrest_binary}.postrust-patch"
: > "$download_log"
supacloud_upgrade_postgrest_binary "$postgrest_binary"
[[ "$(<"$build_count_file")" -eq 2 ]]
supacloud_postrust_patch_stamp_matches "$postgrest_binary"
[[ ! -s "$download_log" ]]

# A URL that names the official layer still source-builds v3.4.0.
export POSTRUST_RELEASE_URL="https://registry-1.docker.io/v2/postrust/postrust/blobs/${SUPACLOUD_POSTRUST_UNPATCHED_LAYER_AMD64}"
export POSTGREST_SHA256="${SUPACLOUD_POSTRUST_UNPATCHED_LAYER_AMD64#sha256:}"
export POSTRUST_BINARY_SHA256="$SUPACLOUD_POSTRUST_UNPATCHED_BINARY_SHA256"
rm -f "${postgrest_binary}.postrust-patch"
: > "$download_log"
supacloud_upgrade_postgrest_binary "$postgrest_binary"
[[ "$(<"$build_count_file")" -eq 3 ]]
supacloud_postrust_patch_stamp_matches "$postgrest_binary"
[[ ! -s "$download_log" ]]
unset POSTRUST_RELEASE_URL POSTGREST_SHA256 POSTRUST_BINARY_SHA256 POSTGREST_VERSION

if [[ "$(uname -m)" == "x86_64" || "$(uname -m)" == "amd64" ]]; then
    install_args="${tmp_dir}/install-args"
    : > "$install_args"
    : > "$download_log"
    supacloud_download_postrust_artifact() {
        printf '%s\n' "$1" >> "$download_log"
        printf 'layer' > "$2"
    }
    supacloud_install_pinned_postrust_layer() {
        printf '%s\n' "$3" "$4" >> "$install_args"
        printf '#!/bin/sh\nprintf "PostgREST %s\\n"\n' "${SUPACLOUD_POSTRUST_TEMPORARY_VERSION#v}" > "$6"
        chmod 755 "$6"
    }
    write_binary v14.16
    rm -f "${postgrest_binary}.postrust-patch" "${postgrest_binary}.postrust-version"
    runtime_active=true
    runtime_binary_current=true
    : > "$systemctl_log"
    supacloud_upgrade_postgrest_binary "$postgrest_binary"
    [[ "$(<"$build_count_file")" -eq 3 ]]
    [[ "$(supacloud_postgrest_binary_version "$postgrest_binary")" == "$SUPACLOUD_POSTRUST_TEMPORARY_VERSION" ]]
    grep -Fq "$SUPACLOUD_POSTRUST_TEMPORARY_LAYER_URL" "$download_log"
    grep -Fq "$SUPACLOUD_POSTRUST_TEMPORARY_LAYER_SHA256" "$install_args"
    grep -Fq "$SUPACLOUD_POSTRUST_TEMPORARY_BINARY_SHA256" "$install_args"
    [[ ! -e "${postgrest_binary}.postrust-patch" ]]
    if grep -Fq 'registry-1.docker.io' "$download_log"; then
        echo "temporary default downloaded the official registry" >&2
        exit 1
    fi
    # The stand-in binary is not the pinned digest, so the next run downloads again.
    : > "$download_log"
    supacloud_upgrade_postgrest_binary "$postgrest_binary"
    grep -Fq "$SUPACLOUD_POSTRUST_TEMPORARY_LAYER_URL" "$download_log"
    [[ "$(<"$build_count_file")" -eq 3 ]]
fi

echo "PostgREST staged global upgrade checks passed"

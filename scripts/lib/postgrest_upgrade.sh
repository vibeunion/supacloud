#!/usr/bin/env bash

# Postrust v3.4.0 (MIT, Copyright 2024 Postrust Contributors).
# Official release: https://github.com/postrust/postrust/releases/tag/v3.4.0
# The host installer default is the published temporary layer
# v3.4.0+supacloud.1. It verifies that layer and the binary inside it.
# POSTGREST_VERSION=v3.4.0 builds the pinned source archive and applies
# docs/patches/postrust-v3.4.0-null-rpc-args.patch with rustc 1.98.1. That
# path does not download the official image. Pins live in postrust_pin.sh.
# shellcheck source=postrust_pin.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/postrust_pin.sh"

SUPACLOUD_POSTGREST_DEFAULT_VERSION="$SUPACLOUD_POSTRUST_TEMPORARY_VERSION"
SUPACLOUD_POSTRUST_BUILD_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/build_supacloud_postrust.sh"

supacloud_postgrest_binary_version() {
    local binary_path="$1"
    local stamp="${binary_path}.postrust-version" version checksum actual magic
    [[ -x "$binary_path" && -f "$binary_path" && ! -L "$binary_path" ]] || return 1
    if [[ -f "$stamp" && ! -L "$stamp" ]]; then
        {
            IFS= read -r version
            IFS= read -r checksum
        } < "$stamp" || return 1
        if [[ "$version" =~ ^v[0-9]+\.[0-9]+(\.[0-9]+)?([+-][A-Za-z0-9._-]+)?$ \
            && "$checksum" =~ ^[0-9a-f]{64}$ ]]; then
            actual=$(sha256sum "$binary_path" | awk '{print $1}' | tr '[:upper:]' '[:lower:]') || return 1
            if [[ "$actual" == "$checksum" ]]; then
                printf '%s' "$version"
                return 0
            fi
        fi
    fi
    # Postrust's server treats --version as a normal start. Only script test
    # doubles may be executed, and only when no matching stamp is present.
    magic=$(od -An -t x1 -N 2 -- "$binary_path" | tr -d ' \n') || return 1
    [[ "$magic" == "2321" ]] || return 1
    version=$("$binary_path" --version 2>/dev/null | head -1) || return 1
    version="${version#PostgREST }"
    version="${version#postrust }"
    version="${version#v}"
    [[ "$version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?([+-][A-Za-z0-9._-]+)?$ ]] || return 1
    printf 'v%s' "$version"
}

supacloud_legacy_postgrest_version() {
    local binary_path="$1"
    local version
    [[ -x "$binary_path" ]] || return 1
    version=$(timeout -k 1 2 "$binary_path" --version 2>/dev/null | head -1 || true)
    [[ "$version" == PostgREST\ * ]] || return 1
    version="${version#PostgREST }"
    version="${version#v}"
    [[ "$version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?([+-][A-Za-z0-9._-]+)?$ ]] || return 1
    printf 'v%s' "$version"
}

supacloud_write_postrust_version_stamp() {
    local binary_path="$1"
    local version="$2"
    local checksum stamp
    checksum=$(sha256sum "$binary_path" | awk '{print $1}' | tr '[:upper:]' '[:lower:]') || return 1
    stamp="${binary_path}.postrust-version"
    printf '%s\n%s\n' "$version" "$checksum" > "$stamp"
    chmod 644 "$stamp"
}

supacloud_build_patched_postrust() {
    local target="$1"
    local out_dir machine arch_tag magic
    out_dir=$(mktemp -d "${TMPDIR:-/tmp}/supacloud-postrust-out.XXXXXX") || return 1
    if ! OUT_DIR="$out_dir" bash "$SUPACLOUD_POSTRUST_BUILD_SCRIPT"; then
        rm -rf -- "$out_dir"
        return 1
    fi
    install -m 0755 "${out_dir}/postrust" "$target" || {
        rm -rf -- "$out_dir"
        return 1
    }
    install -m 0644 "${out_dir}/postrust.postrust-patch" "${target}.postrust-patch" || {
        rm -rf -- "$out_dir"
        return 1
    }
    rm -rf -- "$out_dir"
    if ! supacloud_postrust_patch_stamp_matches "$target"; then
        printf 'Patched Postrust stamp does not match the pinned null-RPC patch\n' >&2
        return 1
    fi
    machine=$(uname -m)
    case "$machine" in
        x86_64|amd64) arch_tag="amd64" ;;
        aarch64|arm64) arch_tag="arm64" ;;
        *)
            printf 'Unsupported architecture for patched Postrust: %s\n' "$machine" >&2
            return 1
            ;;
    esac
    if command -v file >/dev/null 2>&1; then
        supacloud_validate_binary "$target" "pinned-linux-${arch_tag}" || return 1
    else
        magic=$(od -An -t x1 -N 4 -- "$target" | tr -d ' \n') || return 1
        [[ "$magic" == "7f454c46" ]] || {
            printf 'Patched Postrust output is not an ELF binary\n' >&2
            return 1
        }
    fi
}

# Returns 0 when url, layer digest, or binary digest is the official unpatched
# v3.4.0 artifact. The caller must not install that artifact.
supacloud_postrust_official_unpatched_refused() {
    local url="${1:-}"
    local layer_sha256="${2:-}"
    local binary_sha256="${3:-}"
    local unpatched_layer="${SUPACLOUD_POSTRUST_UNPATCHED_LAYER_AMD64#sha256:}"
    layer_sha256=$(printf '%s' "$layer_sha256" | tr '[:upper:]' '[:lower:]')
    binary_sha256=$(printf '%s' "$binary_sha256" | tr '[:upper:]' '[:lower:]')
    if [[ -n "$binary_sha256" && "$binary_sha256" == "$SUPACLOUD_POSTRUST_UNPATCHED_BINARY_SHA256" ]]; then
        printf 'Official unpatched Postrust binary %s is refused and is not installed\n' \
            "$SUPACLOUD_POSTRUST_UNPATCHED_BINARY_SHA256" >&2
        return 0
    fi
    if [[ -n "$layer_sha256" && "$layer_sha256" == "$unpatched_layer" ]]; then
        printf 'Official unpatched Postrust layer %s is refused and is not installed\n' \
            "$unpatched_layer" >&2
        return 0
    fi
    if [[ -n "$url" && "$url" == *"$unpatched_layer"* ]]; then
        printf 'Official unpatched Postrust layer %s is refused and is not installed\n' \
            "$unpatched_layer" >&2
        return 0
    fi
    return 1
}

supacloud_resolve_postgrest_release() {
    local target_version="$1"
    local machine
    [[ "$target_version" =~ ^v[0-9]+\.[0-9]+(\.[0-9]+)?([+-][A-Za-z0-9._-]+)?$ ]] || {
        printf 'Invalid Postrust version (expected v-prefixed release): %s\n' "$target_version" >&2
        return 1
    }
    machine=$(uname -m)
    case "$machine" in
        x86_64|amd64)
            SUPACLOUD_POSTGREST_RELEASE_ARCH="linux-amd64"
            SUPACLOUD_POSTGREST_VALIDATION_ARCH="amd64"
            ;;
        aarch64|arm64)
            printf 'Postrust %s publishes no official linux/arm64 image or release binary (unpatched index %s is amd64 only)\n' \
                "$target_version" "$SUPACLOUD_POSTRUST_UNPATCHED_INDEX_DIGEST" >&2
            return 1
            ;;
        *)
            printf 'Unsupported architecture for Postrust: %s\n' "$machine" >&2
            return 1
            ;;
    esac
    if [[ "$target_version" == "$SUPACLOUD_POSTRUST_UPSTREAM_VERSION" ]]; then
        printf 'Postrust %s is built from the pinned source archive with %s; the official image is not installed\n' \
            "$target_version" "$SUPACLOUD_POSTRUST_PATCH_ID" >&2
        return 1
    fi
    SUPACLOUD_POSTRUST_BINARY_SHA256=""
    if [[ "$target_version" == "$SUPACLOUD_POSTRUST_TEMPORARY_VERSION" ]]; then
        # The published release is the pin. Env overrides cannot retarget it.
        SUPACLOUD_POSTGREST_RELEASE_SHA256="$SUPACLOUD_POSTRUST_TEMPORARY_LAYER_SHA256"
        SUPACLOUD_POSTRUST_BINARY_SHA256="$SUPACLOUD_POSTRUST_TEMPORARY_BINARY_SHA256"
        SUPACLOUD_POSTGREST_RELEASE_URL="$SUPACLOUD_POSTRUST_TEMPORARY_LAYER_URL"
    else
        SUPACLOUD_POSTGREST_RELEASE_SHA256="${POSTGREST_SHA256:-}"
        SUPACLOUD_POSTRUST_BINARY_SHA256="${POSTRUST_BINARY_SHA256:-}"
        SUPACLOUD_POSTGREST_RELEASE_URL="${POSTRUST_RELEASE_URL:-https://example.invalid/postrust/${target_version}.layer.tar.gz}"
        if [[ ! "$SUPACLOUD_POSTGREST_RELEASE_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; then
            printf 'POSTGREST_SHA256 is required for unpinned Postrust version %s\n' "$target_version" >&2
            return 1
        fi
        if [[ -n "$SUPACLOUD_POSTRUST_BINARY_SHA256" && ! "$SUPACLOUD_POSTRUST_BINARY_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; then
            printf 'POSTRUST_BINARY_SHA256 is not a SHA256 digest\n' >&2
            return 1
        fi
    fi
    if supacloud_postrust_official_unpatched_refused \
        "$SUPACLOUD_POSTGREST_RELEASE_URL" \
        "$SUPACLOUD_POSTGREST_RELEASE_SHA256" \
        "$SUPACLOUD_POSTRUST_BINARY_SHA256"; then
        return 1
    fi
    SUPACLOUD_POSTGREST_RELEASE_ASSET="$SUPACLOUD_POSTRUST_LAYER_MEMBER"
}

supacloud_download_postrust_artifact() {
    local url="$1"
    local output="$2"
    local token_file token
    if supacloud_postrust_official_unpatched_refused "$url" "" ""; then
        return 1
    fi
    if [[ "$url" == https://registry-1.docker.io/v2/postrust/postrust/blobs/sha256:* ]]; then
        token_file=$(mktemp) || return 1
        curl -fsSL --proto '=https' --proto-redir '=https' \
            --retry 1 --retry-delay 2 --retry-max-time 60 \
            --connect-timeout 15 --max-time 30 \
            -o "$token_file" \
            "https://auth.docker.io/token?service=registry.docker.io&scope=repository:postrust/postrust:pull" || {
            rm -f "$token_file"
            return 1
        }
        token=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$token_file")
        rm -f "$token_file"
        [[ -n "$token" ]] || return 1
        curl -fL --proto '=https' --proto-redir '=https' \
            --retry 1 --retry-delay 2 --retry-max-time 180 \
            --connect-timeout 15 --max-time 180 \
            -H "Authorization: Bearer ${token}" \
            -o "$output" "$url"
        return
    fi
    supacloud_download_url "$url" "$output"
}

supacloud_install_pinned_postrust_layer() (
    local archive="$1"
    local member="$2"
    local expected_sha256="$3"
    local expected_binary_sha256="$4"
    local arch="$5"
    local target="$6"
    local actual_sha256 member_count member_details extract_dir candidate staged_target binary_sha256

    actual_sha256=$(sha256sum "$archive" | awk '{print $1}')
    actual_sha256=$(printf '%s' "$actual_sha256" | tr '[:upper:]' '[:lower:]')
    expected_sha256=$(printf '%s' "$expected_sha256" | tr '[:upper:]' '[:lower:]')
    if supacloud_postrust_official_unpatched_refused "" "$actual_sha256" "" \
        || supacloud_postrust_official_unpatched_refused "" "$expected_sha256" ""; then
        return 1
    fi
    if [[ ! "$expected_sha256" =~ ^[0-9a-f]{64}$ || "$actual_sha256" != "$expected_sha256" ]]; then
        echo "SHA256 mismatch for pinned Postrust layer" >&2
        return 1
    fi

    member_count=$(tar -tzf "$archive" | grep -Fxc "$member" || true)
    if [[ "$member_count" != "1" ]]; then
        echo "Pinned Postrust layer must contain the exact member once: $member" >&2
        return 1
    fi
    member_details=$(tar -tvzf "$archive" "$member") || return 1
    if [[ "${member_details:0:1}" != "-" ]]; then
        echo "Pinned Postrust layer member is not a regular file: $member" >&2
        return 1
    fi

    extract_dir=$(mktemp -d)
    trap 'rm -rf "$extract_dir"; [[ -z "${staged_target:-}" ]] || rm -f "$staged_target"' EXIT
    trap 'trap - EXIT HUP INT TERM; rm -rf "$extract_dir"; [[ -z "${staged_target:-}" ]] || rm -f "$staged_target"; exit 1' HUP INT TERM
    if ! tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$extract_dir" "$member"; then
        return 1
    fi
    candidate="${extract_dir}/${member}"
    binary_sha256=$(sha256sum "$candidate" | awk '{print $1}' | tr '[:upper:]' '[:lower:]')
    if supacloud_postrust_official_unpatched_refused "" "" "$binary_sha256"; then
        return 1
    fi
    if [[ -n "$expected_binary_sha256" ]]; then
        expected_binary_sha256=$(printf '%s' "$expected_binary_sha256" | tr '[:upper:]' '[:lower:]')
        if supacloud_postrust_official_unpatched_refused "" "" "$expected_binary_sha256"; then
            return 1
        fi
        [[ "$binary_sha256" == "$expected_binary_sha256" ]] || {
            echo "SHA256 mismatch for pinned Postrust binary" >&2
            return 1
        }
    fi
    supacloud_validate_binary "$candidate" "pinned-linux-${arch}" || return 1

    mkdir -p "$(dirname "$target")"
    staged_target=$(mktemp "${target}.tmp.XXXXXX")
    install -m 0755 "$candidate" "$staged_target"
    mv -f "$staged_target" "$target"
    staged_target=""
)

supacloud_postgrest_active_units() {
    local unit units
    units=$(systemctl list-units --type=service --state=running --no-legend --no-pager 'supacloud-postrust@*.service') || return 1
    while read -r unit _; do
        [[ "$unit" =~ ^supacloud-postrust@[a-z0-9-]{1,20}\.service$ ]] || continue
        printf '%s\n' "$unit"
    done <<< "$units"
}

supacloud_postgrest_unit_ref() {
    local unit="$1"
    local ref="${unit#supacloud-postrust@}"
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
    if [[ -d "${backup_dir}/version-stamp" ]]; then
        supacloud_restore_file_snapshot "${binary_path}.postrust-version" "${backup_dir}/version-stamp" || return 1
    else
        rm -f -- "${binary_path}.postrust-version"
    fi
    if [[ -d "${backup_dir}/patch-stamp" ]]; then
        supacloud_restore_file_snapshot "${binary_path}.postrust-patch" "${backup_dir}/patch-stamp" || return 1
    else
        rm -f -- "${binary_path}.postrust-patch"
    fi
    systemctl daemon-reload || return 1
    [[ -z "$previous_version" ]] || supacloud_restart_postgrest_units "$units_file" "$binary_path" "$previous_version"
}

supacloud_upgrade_postgrest_binary_transaction() (
    local binary_path="$1"
    local result_file="$2"
    local target_version="${POSTGREST_VERSION:-$SUPACLOUD_POSTGREST_DEFAULT_VERSION}"
    local current_version="" transaction_dir archive staged_binary="" staged_patch="" backup_dir active_units stopped_units status=0
    local binary_requires_upgrade=false use_source_build=false installed_sha=""

    [[ "$target_version" =~ ^v[0-9]+\.[0-9]+(\.[0-9]+)?([+-][A-Za-z0-9._-]+)?$ ]] || {
        printf 'Invalid Postrust version (expected v-prefixed release): %s\n' "$target_version" >&2
        return 1
    }
    if [[ -e "$binary_path" ]]; then
        [[ -f "$binary_path" && ! -L "$binary_path" ]] || {
            printf 'Existing PostgREST target must be a regular file: %s\n' "$binary_path" >&2
            return 1
        }
        current_version=$(supacloud_postgrest_binary_version "$binary_path" 2>/dev/null || true)
        if [[ -z "$current_version" ]]; then
            current_version=$(supacloud_legacy_postgrest_version "$binary_path") || {
                printf 'Unable to read the existing Postrust version from %s\n' "$binary_path" >&2
                return 1
            }
        fi
    fi
    # Explicit v3.4.0 is the null-RPC source build. The default temporary
    # layer is a verified download and must not take this branch.
    if [[ "$target_version" == "$SUPACLOUD_POSTRUST_UPSTREAM_VERSION" ]]; then
        use_source_build=true
    fi
    if [[ "$current_version" != "$target_version" ]]; then
        binary_requires_upgrade=true
    elif [[ "$use_source_build" == true ]] && ! supacloud_postrust_patch_stamp_matches "$binary_path"; then
        binary_requires_upgrade=true
    elif [[ "$target_version" == "$SUPACLOUD_POSTRUST_TEMPORARY_VERSION" ]]; then
        installed_sha=$(sha256sum "$binary_path" | awk '{print $1}' | tr '[:upper:]' '[:lower:]') || return 1
        if [[ "$installed_sha" != "$SUPACLOUD_POSTRUST_TEMPORARY_BINARY_SHA256" ]]; then
            binary_requires_upgrade=true
        fi
    fi
    if [[ "$binary_requires_upgrade" == true && "$use_source_build" == false ]]; then
        supacloud_resolve_postgrest_release "$target_version" || return 1
    fi

    transaction_dir=$(mktemp -d "${TMPDIR:-/tmp}/supacloud-postgrest-upgrade.XXXXXX") || return 1
    chmod 700 "$transaction_dir"
    active_units="${transaction_dir}/active-units"
    stopped_units="${transaction_dir}/stopped-units"
    trap 'rm -rf -- "${transaction_dir:-}"; [[ -z "${staged_binary:-}" ]] || rm -f -- "$staged_binary"; [[ -z "${staged_patch:-}" ]] || rm -f -- "$staged_patch"' EXIT HUP INT TERM
    supacloud_postgrest_active_units > "$active_units" || return 1
    chmod 600 "$active_units"

    if [[ "$binary_requires_upgrade" == false ]] \
        && supacloud_postgrest_units_are_attested "$active_units" "$binary_path" "$target_version"; then
        return 0
    fi

    if [[ "$binary_requires_upgrade" == true ]]; then
        staged_binary="${binary_path}.staged.$$"
        staged_patch="${staged_binary}.postrust-patch"
        if [[ "$use_source_build" == true ]]; then
            printf 'Building Postrust %s with %s\n' "$target_version" "$SUPACLOUD_POSTRUST_PATCH_ID"
            supacloud_build_patched_postrust "$staged_binary" || return 1
        else
            archive="${transaction_dir}/postrust-layer.tar.gz"
            supacloud_download_postrust_artifact "$SUPACLOUD_POSTGREST_RELEASE_URL" "$archive" || return 1
            supacloud_install_pinned_postrust_layer "$archive" "$SUPACLOUD_POSTRUST_LAYER_MEMBER" \
                "$SUPACLOUD_POSTGREST_RELEASE_SHA256" "$SUPACLOUD_POSTRUST_BINARY_SHA256" \
                "$SUPACLOUD_POSTGREST_VALIDATION_ARCH" "$staged_binary" || return 1
            if [[ -z "$SUPACLOUD_POSTRUST_BINARY_SHA256" ]]; then
                [[ "$(supacloud_postgrest_binary_version "$staged_binary")" == "$target_version" ]] || {
                    printf 'Staged Postrust binary version does not match %s\n' "$target_version" >&2
                    return 1
                }
            fi
        fi
    fi

    mkdir -p "${SUPACLOUD_POSTGREST_BACKUP_ROOT:-/var/lib/supacloud/backups/postgrest}" || return 1
    chmod 700 "${SUPACLOUD_POSTGREST_BACKUP_ROOT:-/var/lib/supacloud/backups/postgrest}" || return 1
    backup_dir=$(mktemp -d "${SUPACLOUD_POSTGREST_BACKUP_ROOT:-/var/lib/supacloud/backups/postgrest}/${target_version}-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX") || return 1
    supacloud_capture_file_snapshot "$binary_path" "${backup_dir}/binary" || return 1
    supacloud_capture_file_snapshot "${binary_path}.postrust-version" "${backup_dir}/version-stamp" || return 1
    supacloud_capture_file_snapshot "${binary_path}.postrust-patch" "${backup_dir}/patch-stamp" || return 1

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
        if (( status == 0 )); then
            if [[ "$use_source_build" == true ]]; then
                if [[ -f "$staged_patch" ]] && mv -f "$staged_patch" "${binary_path}.postrust-patch"; then
                    staged_patch=""
                else
                    status=1
                fi
            else
                rm -f -- "${binary_path}.postrust-patch"
                staged_patch=""
            fi
        fi
    fi
    if (( status == 0 )); then chmod 755 "$binary_path" || status=$?; fi
    if (( status == 0 )); then supacloud_write_postrust_version_stamp "$binary_path" "$target_version" || status=$?; fi
    if (( status == 0 )) && [[ "$(supacloud_postgrest_binary_version "$binary_path" 2>/dev/null || true)" != "$target_version" ]]; then
        status=1
    fi
    if (( status == 0 )) && [[ "$use_source_build" == true ]] && ! supacloud_postrust_patch_stamp_matches "$binary_path"; then
        printf 'Installed Postrust binary is missing the %s stamp\n' "$SUPACLOUD_POSTRUST_PATCH_ID" >&2
        status=1
    fi
    if (( status == 0 )); then systemctl daemon-reload || status=$?; fi
    if (( status == 0 )); then supacloud_restart_postgrest_units "$active_units" "$binary_path" "$target_version" || status=$?; fi
    if (( status != 0 )); then
        supacloud_rollback_postgrest_upgrade "$binary_path" "$backup_dir" "$active_units" "$current_version" || {
            printf 'Postrust rollback failed; recovery backup: %s\n' "$backup_dir" >&2
            return 1
        }
        printf 'Postrust upgrade failed and the previous runtime was restored\n' >&2
        return "$status"
    fi
    printf '%s' "$backup_dir" > "$result_file"
)

supacloud_upgrade_postgrest_binary() {
    local binary_path="${1:-/usr/local/bin/postrust}"
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

#!/usr/bin/env bash
# Build Postrust v3.4.0 from the pinned tag archive with the null-RPC patch.
# The official image is not an input. See docs/postrust-v3.4.0-adoption.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIN_FILE="${SUPACLOUD_POSTRUST_PIN:-${SCRIPT_DIR}/lib/postrust_pin.sh}"
# shellcheck source=lib/postrust_pin.sh
source "$PIN_FILE"

OUT_DIR="${OUT_DIR:-dist}"
mkdir -p "$OUT_DIR"

patch_file="${SUPACLOUD_POSTRUST_PATCH:-${SCRIPT_DIR}/../docs/patches/${SUPACLOUD_POSTRUST_PATCH_ID}.patch}"
[[ -f "$patch_file" && ! -L "$patch_file" ]] || {
    printf 'Postrust null-RPC patch is missing: %s\n' "$patch_file" >&2
    exit 1
}
command -v patch >/dev/null 2>&1 || {
    printf 'patch is required to build Postrust\n' >&2
    exit 1
}
command -v curl >/dev/null 2>&1 || {
    printf 'curl is required to build Postrust\n' >&2
    exit 1
}

sha256_file() {
    sha256sum "$1" | awk '{print $1}' | tr '[:upper:]' '[:lower:]'
}

actual_patch=$(sha256_file "$patch_file")
[[ "$actual_patch" == "$SUPACLOUD_POSTRUST_PATCH_SHA256" ]] || {
    printf 'Postrust null-RPC patch SHA256 mismatch\n' >&2
    exit 1
}

download_verified() {
    local url="$1"
    local output="$2"
    local expected="$3"
    local temporary="" actual=""
    if [[ -f "$output" && ! -L "$output" ]] && [[ "$(sha256_file "$output")" == "$expected" ]]; then
        return 0
    fi
    temporary=$(mktemp "${output}.partial.XXXXXX")
    curl -fL --proto '=https' --proto-redir '=https' \
        --retry 3 --retry-delay 2 --retry-max-time 300 \
        --connect-timeout 20 --max-time 600 \
        -o "$temporary" "$url" || {
        rm -f -- "$temporary"
        return 1
    }
    actual=$(sha256_file "$temporary")
    if [[ "$actual" != "$expected" ]]; then
        rm -f -- "$temporary"
        printf 'SHA256 mismatch for %s\n' "$url" >&2
        return 1
    fi
    mv -f "$temporary" "$output"
}

supacloud_postrust_ensure_rustc() {
    local prefix machine triple dist_sha dist_name archive extract_dir
    if [[ "${SUPACLOUD_POSTRUST_SKIP_RUST_INSTALL:-}" != "1" ]]; then
        prefix="${SUPACLOUD_POSTRUST_RUST_PREFIX:-${HOME}/.supacloud/rust-${SUPACLOUD_POSTRUST_RUSTC_VERSION}}"
        if [[ ! -x "${prefix}/bin/rustc" ]] \
            || [[ "$("${prefix}/bin/rustc" --version 2>/dev/null || true)" != "rustc ${SUPACLOUD_POSTRUST_RUSTC_VERSION} "* ]]; then
            machine=$(uname -m)
            case "$machine" in
                x86_64|amd64)
                    triple="x86_64-unknown-linux-gnu"
                    dist_sha="$SUPACLOUD_POSTRUST_RUST_DIST_SHA256_X86_64"
                    ;;
                aarch64|arm64)
                    triple="aarch64-unknown-linux-gnu"
                    dist_sha="$SUPACLOUD_POSTRUST_RUST_DIST_SHA256_AARCH64"
                    ;;
                *)
                    printf 'Unsupported architecture for the pinned Rust toolchain: %s\n' "$machine" >&2
                    return 1
                    ;;
            esac
            dist_name="rust-${SUPACLOUD_POSTRUST_RUSTC_VERSION}-${triple}"
            mkdir -p "${SUPACLOUD_POSTRUST_CACHE_DIR:-${HOME}/.cache/supacloud}"
            archive="${SUPACLOUD_POSTRUST_CACHE_DIR:-${HOME}/.cache/supacloud}/${dist_name}.tar.gz"
            download_verified \
                "https://static.rust-lang.org/dist/${dist_name}.tar.gz" \
                "$archive" \
                "$dist_sha"
            extract_dir=$(mktemp -d "${TMPDIR:-/tmp}/supacloud-rust.XXXXXX")
            tar -xzf "$archive" -C "$extract_dir"
            rm -rf -- "$prefix"
            "${extract_dir}/${dist_name}/install.sh" \
                --prefix="$prefix" \
                --without=rust-docs,rust-docs-json-preview
            rm -rf -- "$extract_dir"
        fi
        export PATH="${prefix}/bin:${PATH}"
    fi
    command -v rustc >/dev/null 2>&1 || {
        printf 'rustc %s is required to build Postrust\n' "$SUPACLOUD_POSTRUST_RUSTC_VERSION" >&2
        return 1
    }
    command -v cargo >/dev/null 2>&1 || {
        printf 'cargo %s is required to build Postrust\n' "$SUPACLOUD_POSTRUST_RUSTC_VERSION" >&2
        return 1
    }
    local actual
    actual=$(rustc --version)
    [[ "$actual" == "rustc ${SUPACLOUD_POSTRUST_RUSTC_VERSION} "* ]] || {
        printf 'Postrust build requires rustc %s; found %s\n' "$SUPACLOUD_POSTRUST_RUSTC_VERSION" "$actual" >&2
        return 1
    }
}

supacloud_postrust_ensure_rustc

cache_dir="${SUPACLOUD_POSTRUST_CACHE_DIR:-${HOME}/.cache/supacloud}"
mkdir -p "$cache_dir"
source_archive="${cache_dir}/postrust-${SUPACLOUD_POSTRUST_UPSTREAM_VERSION}.tar.gz"
download_verified "$SUPACLOUD_POSTRUST_SOURCE_URL" "$source_archive" "$SUPACLOUD_POSTRUST_SOURCE_SHA256"

src_root=$(mktemp -d "${TMPDIR:-/tmp}/supacloud-postrust-src.XXXXXX")
trap 'rm -rf -- "${src_root:-}"' EXIT
tar -xzf "$source_archive" -C "$src_root"
src="${src_root}/postrust-${SUPACLOUD_POSTRUST_UPSTREAM_VERSION#v}"
[[ -d "$src" ]] || {
    printf 'Postrust source archive did not contain %s\n' "$src" >&2
    exit 1
}
patch -p1 --forward --batch -d "$src" -i "$patch_file"

export CARGO_TERM_COLOR=never
export CARGO_TARGET_DIR="${SUPACLOUD_POSTRUST_TARGET_DIR:-${src}/target}"
mkdir -p "$CARGO_TARGET_DIR"
(
    cd "$src"
    cargo build --release --locked -p postrust-server --features "$SUPACLOUD_POSTRUST_FEATURES"
)

install -m 0755 "${CARGO_TARGET_DIR}/release/postrust" "${OUT_DIR}/postrust"
printf '%s\n%s\n%s\n%s\n%s\n' \
    "$SUPACLOUD_POSTRUST_PATCH_ID" \
    "$SUPACLOUD_POSTRUST_PATCH_SHA256" \
    "$SUPACLOUD_POSTRUST_SOURCE_SHA256" \
    "$SUPACLOUD_POSTRUST_RUSTC_VERSION" \
    "$SUPACLOUD_POSTRUST_FEATURES" \
    > "${OUT_DIR}/postrust.postrust-patch"
chmod 0644 "${OUT_DIR}/postrust.postrust-patch"
supacloud_postrust_patch_stamp_matches "${OUT_DIR}/postrust" || {
    printf 'Built Postrust binary does not match the null-RPC patch stamp\n' >&2
    exit 1
}

binary_sha=$(sha256_file "${OUT_DIR}/postrust")
(
    cd "$OUT_DIR"
    sha256sum postrust > SHA256SUMS.postrust
)
chmod 0644 "${OUT_DIR}/SHA256SUMS.postrust"

magic=$(od -An -t x1 -N 4 -- "${OUT_DIR}/postrust" | tr -d ' \n')
[[ "$magic" == "7f454c46" ]] || {
    printf 'Built Postrust output is not an ELF binary\n' >&2
    exit 1
}

printf 'Patched Postrust %s (%s) sha256 %s\n' \
    "$SUPACLOUD_POSTRUST_UPSTREAM_VERSION" \
    "$SUPACLOUD_POSTRUST_PATCH_ID" \
    "$binary_sha"

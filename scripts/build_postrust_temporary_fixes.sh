#!/usr/bin/env bash

# Build the temporary SupaCloud Postrust v3.4.0 layer.
#
# This is not an upstream Postrust release. It applies the two fixes that the
# official v3.4.0 binary still lacks, then produces a deterministic OCI-style
# layer for the installer. The resulting binary and layer digests are pinned in
# scripts/lib/postgrest_upgrade.sh.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_VERSION="${POSTRUST_SOURCE_VERSION:-v3.4.0}"
SOURCE_SHA256="2c5de117fe288a18046776dfd0505d21845ba49b072d62bdab2c29ce3f2fe722"
PATCH_FILE="${ROOT_DIR}/docs/patches/postrust-v3.4.0-temporary-fixes.patch"
EXPECTED_BINARY_SHA256="647e3f3d649f96adca20db8d8b774167d8b4129d186dfa76839e6ed8866c457e"
EXPECTED_LAYER_SHA256="e9e721400159b4e2cce78a860b2989cb67b3eb3628a232a57a0bd8a0072be79e"
OUTPUT_DIR="${1:-${ROOT_DIR}/dist/postrust-v3.4.0-supacloud.1}"
ASSET_NAME="postrust-v3.4.0-supacloud.1-linux-amd64.tar.gz"

fail() {
    printf 'build_postrust_temporary_fixes: %s\n' "$*" >&2
    exit 1
}

command -v cargo >/dev/null 2>&1 || fail "cargo is required; install Rust 1.94.1 from https://rustup.rs"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v patch >/dev/null 2>&1 || fail "patch is required"
[[ -f "$PATCH_FILE" ]] || fail "missing patch: $PATCH_FILE"

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/postrust-temporary-fixes.XXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT HUP INT TERM

source_archive="${work_dir}/postrust-${SOURCE_VERSION}.tar.gz"
curl -fsSL --proto '=https' --proto-redir '=https' \
    --retry 3 --retry-delay 2 --retry-max-time 180 \
    --connect-timeout 15 --max-time 180 \
    -o "$source_archive" \
    "https://github.com/postrust/postrust/archive/refs/tags/${SOURCE_VERSION}.tar.gz"

actual_source_sha256=$(sha256sum "$source_archive" | awk '{print $1}')
[[ "$actual_source_sha256" == "$SOURCE_SHA256" ]] || \
    fail "source archive SHA256 mismatch: ${actual_source_sha256}"

tar -xzf "$source_archive" -C "$work_dir"
source_dir="${work_dir}/postrust-${SOURCE_VERSION#v}"
[[ -d "$source_dir" ]] || fail "source directory is missing: $source_dir"

(
    cd "$source_dir"
    patch --batch --forward -p1 < "$PATCH_FILE"
    cargo build --release --locked -p postrust-server --features admin-ui,otel
)

built_binary="${source_dir}/target/release/postrust"
[[ -x "$built_binary" ]] || fail "release binary is missing"
actual_binary_sha256=$(sha256sum "$built_binary" | awk '{print $1}')
[[ "$actual_binary_sha256" == "$EXPECTED_BINARY_SHA256" ]] || \
    fail "binary SHA256 mismatch: ${actual_binary_sha256}"

mkdir -p "${work_dir}/layer/usr/local/bin"
install -m 0755 "$built_binary" "${work_dir}/layer/usr/local/bin/postrust"
(
    cd "${work_dir}/layer"
    tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --format=gnu \
        -cf - usr/local/bin/postrust | gzip -n -9 > "${work_dir}/${ASSET_NAME}"
)
actual_layer_sha256=$(sha256sum "${work_dir}/${ASSET_NAME}" | awk '{print $1}')
[[ "$actual_layer_sha256" == "$EXPECTED_LAYER_SHA256" ]] || \
    fail "layer SHA256 mismatch: ${actual_layer_sha256}"

mkdir -p "$OUTPUT_DIR"
install -m 0644 "${work_dir}/${ASSET_NAME}" "${OUTPUT_DIR}/${ASSET_NAME}"
install -m 0644 "$PATCH_FILE" "${OUTPUT_DIR}/postrust-v3.4.0-temporary-fixes.patch"
(
    cd "$OUTPUT_DIR"
    sha256sum "$ASSET_NAME" postrust-v3.4.0-temporary-fixes.patch > SHA256SUMS
)

printf 'built %s\n' "${OUTPUT_DIR}/${ASSET_NAME}"
printf 'binary sha256 %s\n' "$actual_binary_sha256"
printf 'layer sha256 %s\n' "$actual_layer_sha256"
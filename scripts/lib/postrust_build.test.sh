#!/usr/bin/env bash
# POSTGREST_VERSION=v3.4.0 applies the null-RPC patch to the pinned v3.4.0
# archive and does not select the official image. The host installer default
# is the temporary layer; this file checks the source-build path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postrust_pin.sh
source "${SCRIPT_DIR}/postrust_pin.sh"

patch_file="${SCRIPT_DIR}/../../docs/patches/${SUPACLOUD_POSTRUST_PATCH_ID}.patch"
build_script="${SCRIPT_DIR}/../build_supacloud_postrust.sh"
upgrade_script="${SCRIPT_DIR}/postgrest_upgrade.sh"
dockerfile="${SCRIPT_DIR}/../../docker/self-host/postrust/Dockerfile"

[[ -f "$patch_file" && -f "$build_script" && -f "$upgrade_script" && -f "$dockerfile" ]]
actual_patch=$(sha256sum "$patch_file" | awk '{print $1}' | tr '[:upper:]' '[:lower:]')
[[ "$actual_patch" == "$SUPACLOUD_POSTRUST_PATCH_SHA256" ]]

grep -Fq 'supacloud_build_patched_postrust' "$upgrade_script"
grep -Fq 'cargo build --release --locked -p postrust-server' "$build_script"
grep -Fq "$SUPACLOUD_POSTRUST_PATCH_ID" "${SCRIPT_DIR}/postrust_pin.sh"
grep -Fq 'org.supacloud.postrust.patch="postrust-v3.4.0-null-rpc-args"' "$dockerfile"
grep -Fq 'SUPACLOUD_POSTRUST_SKIP_RUST_INSTALL=1' "$dockerfile"
if grep -Fq 'registry-1.docker.io/v2/postrust/postrust/blobs/${SUPACLOUD_POSTRUST_LAYER_AMD64}' "$upgrade_script"; then
    echo "default Postrust upgrade still selects the official image layer" >&2
    exit 1
fi
if grep -Fq "SUPACLOUD_POSTRUST_BINARY_AMD64_SHA256=\"${SUPACLOUD_POSTRUST_UNPATCHED_BINARY_SHA256}\"" "$upgrade_script"; then
    echo "default Postrust upgrade still pins the unpatched official binary" >&2
    exit 1
fi
grep -Fq "$SUPACLOUD_POSTRUST_TEMPORARY_LAYER_SHA256" "${SCRIPT_DIR}/postrust_pin.sh"
grep -Fq "$SUPACLOUD_POSTRUST_TEMPORARY_BINARY_SHA256" "${SCRIPT_DIR}/postrust_pin.sh"
grep -Fq 'RUSTUP_TOOLCHAIN: "1.94.1"' "${SCRIPT_DIR}/../../.github/workflows/postrust-temporary-fixes.yml"
grep -Fq 'install Rust 1.94.1' "${SCRIPT_DIR}/../build_postrust_temporary_fixes.sh"
grep -Fq 'SUPACLOUD_POSTRUST_RUSTC_VERSION="1.98.1"' "${SCRIPT_DIR}/postrust_pin.sh"

cache_dir="${TMPDIR:-/tmp}/supacloud-postrust-patch-test"
mkdir -p "$cache_dir"
archive="${cache_dir}/postrust-${SUPACLOUD_POSTRUST_UPSTREAM_VERSION}.tar.gz"
if [[ ! -f "$archive" ]] || [[ "$(sha256sum "$archive" | awk '{print $1}')" != "$SUPACLOUD_POSTRUST_SOURCE_SHA256" ]]; then
    temporary=$(mktemp "${cache_dir}/postrust.partial.XXXXXX")
    curl -fL --proto '=https' --proto-redir '=https' \
        --retry 3 --retry-delay 2 --retry-max-time 180 \
        --connect-timeout 20 --max-time 180 \
        -o "$temporary" "$SUPACLOUD_POSTRUST_SOURCE_URL"
    actual_source=$(sha256sum "$temporary" | awk '{print $1}' | tr '[:upper:]' '[:lower:]')
    [[ "$actual_source" == "$SUPACLOUD_POSTRUST_SOURCE_SHA256" ]]
    mv -f "$temporary" "$archive"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xzf "$archive" -C "$work"
src="${work}/postrust-${SUPACLOUD_POSTRUST_UPSTREAM_VERSION#v}"
patch -p1 --forward --dry-run -d "$src" -i "$patch_file" >/dev/null
patch -p1 --forward --batch -d "$src" -i "$patch_file" >/dev/null
grep -Fq 'if v.is_null()' "${src}/crates/postrust-core/src/plan/call_plan.rs"
grep -Fq 'NULL::' "${src}/crates/postrust-core/src/query/builder.rs"
if grep -Fq 'serde_json::Value::Null => String::new()' "${src}/crates/postrust-core/src/plan/call_plan.rs"; then
    echo "patched call_plan.rs still maps JSON null to an empty string" >&2
    exit 1
fi

echo "Postrust null-RPC patch applies to pinned v3.4.0 source"

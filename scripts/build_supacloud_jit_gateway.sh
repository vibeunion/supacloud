#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="${SCRIPT_DIR}/crates/jit-gateway"
OUT_DIR="${OUT_DIR:-${SCRIPT_DIR}/dist}"

mkdir -p "$OUT_DIR"

if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo is required to build supacloud-jit-gateway. Install Rust from https://rustup.rs" >&2
    exit 1
fi

echo "=> Building supacloud-jit-gateway (release)..."
cargo build --release --manifest-path "${CRATE_DIR}/Cargo.toml"

TARGET_BIN="${CRATE_DIR}/target/release/supacloud-jit-gateway"
if [[ ! -f "$TARGET_BIN" ]]; then
    echo "Build output not found at ${TARGET_BIN}" >&2
    exit 1
fi

DEST_BIN="${OUT_DIR}/supacloud-jit-gateway"
install -m 0755 "$TARGET_BIN" "$DEST_BIN"
echo "=> Successfully built: ${DEST_BIN}"

if command -v sha256sum >/dev/null 2>&1; then
    (cd "$OUT_DIR" && sha256sum "supacloud-jit-gateway" > SHA256SUMS.jit-gateway)
elif command -v shasum >/dev/null 2>&1; then
    (cd "$OUT_DIR" && shasum -a 256 "supacloud-jit-gateway" > SHA256SUMS.jit-gateway)
fi

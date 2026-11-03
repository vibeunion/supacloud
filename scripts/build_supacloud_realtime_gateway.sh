#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="${SCRIPT_DIR}/crates/realtime-gateway"
OUT_DIR="${OUT_DIR:-${SCRIPT_DIR}/dist}"

mkdir -p "$OUT_DIR"

if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo is required to build supacloud-realtime-gateway. Install Rust from https://rustup.rs" >&2
    exit 1
fi

echo "=> Building supacloud-realtime-gateway (release)..."
cargo build --release --manifest-path "${CRATE_DIR}/Cargo.toml"

TARGET_BIN="${CRATE_DIR}/target/release/supacloud-realtime-gateway"
if [[ ! -f "$TARGET_BIN" ]]; then
    echo "Build output not found at ${TARGET_BIN}" >&2
    exit 1
fi

DEST_BIN="${OUT_DIR}/supacloud-realtime-gateway"
install -m 0755 "$TARGET_BIN" "$DEST_BIN"
echo "=> Successfully built: ${DEST_BIN}"

if command -v sha256sum >/dev/null 2>&1; then
    (cd "$OUT_DIR" && sha256sum "supacloud-realtime-gateway" > SHA256SUMS.realtime-gateway)
elif command -v shasum >/dev/null 2>&1; then
    (cd "$OUT_DIR" && shasum -a 256 "supacloud-realtime-gateway" > SHA256SUMS.realtime-gateway)
fi

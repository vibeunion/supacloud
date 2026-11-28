#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="${SCRIPT_DIR}/crates/office-converter"
OUT_DIR="${OUT_DIR:-${SCRIPT_DIR}/dist}"

mkdir -p "$OUT_DIR"

if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo is required to build supacloud-office-converter" >&2
    exit 1
fi

echo "=> Building supacloud-office-converter..."
(cd "$CRATE_DIR" && cargo build --release --locked)
install -m 0755 \
    "${CRATE_DIR}/target/release/supacloud-office-converter" \
    "${OUT_DIR}/supacloud-office-converter"
echo "=> Successfully built: ${OUT_DIR}/supacloud-office-converter"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-${ROOT_DIR}/dist}"
DEST="${SUPACLOUD_OFFICE_CONVERSION_BIN:-/usr/local/bin/supacloud-office-converter}"

if [[ "$DEST" != /* || "$DEST" == */ ]]; then
    echo "destination must be an absolute file path: $DEST" >&2
    exit 1
fi

echo "=> Building the optional Office converter..."
OUT_DIR="$OUT_DIR" "${ROOT_DIR}/scripts/build_supacloud_office.sh"

install -d "$(dirname "$DEST")"
install -m 0755 "${OUT_DIR}/supacloud-office-converter" "$DEST"
echo "=> Installed: $DEST"
echo "=> No service was started; enable the Worker explicitly before use."

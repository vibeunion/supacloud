#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="${SCRIPT_DIR}/packages/management-api"
OUT_DIR="${OUT_DIR:-${SCRIPT_DIR}/dist}"

mkdir -p "$OUT_DIR"

if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required to build supacloud-image. Install it from https://bun.sh" >&2
    exit 1
fi

case "$(uname -s)/$(uname -m)" in
    Linux/x86_64|Linux/amd64) TARGET="bun-linux-x64" ;;
    Linux/aarch64|Linux/arm64) TARGET="bun-linux-arm64" ;;
    Darwin/arm64) TARGET="bun-darwin-arm64" ;;
    Darwin/x86_64) TARGET="bun-darwin-x64" ;;
    *)
        echo "Unsupported build host: $(uname -s)/$(uname -m)" >&2
        exit 1
        ;;
esac

if [[ ! -d "${API_DIR}/node_modules/@napi-rs/image" ]]; then
    (cd "$API_DIR" && bun install --frozen-lockfile 2>/dev/null) || (cd "$API_DIR" && bun install)
fi

echo "=> Building supacloud-image (${TARGET})..."
(cd "$API_DIR" && bun build src/image-service/main.ts --compile --target="$TARGET" --outfile="${OUT_DIR}/supacloud-image")

DEST_BIN="${OUT_DIR}/supacloud-image"
if [[ ! -x "$DEST_BIN" ]]; then
    echo "Build output not found at ${DEST_BIN}" >&2
    exit 1
fi
echo "=> Successfully built: ${DEST_BIN}"

if command -v sha256sum >/dev/null 2>&1; then
    (cd "$OUT_DIR" && sha256sum "supacloud-image" > SHA256SUMS.image-service)
elif command -v shasum >/dev/null 2>&1; then
    (cd "$OUT_DIR" && shasum -a 256 "supacloud-image" > SHA256SUMS.image-service)
fi

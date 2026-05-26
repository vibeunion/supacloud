#!/usr/bin/env bash
set -euo pipefail

CADDY_VERSION="${CADDY_VERSION:-v2.10.2}"
RATE_LIMIT_MODULE="${RATE_LIMIT_MODULE:-github.com/mholt/caddy-ratelimit}"
OUT_DIR="${OUT_DIR:-dist}"
mkdir -p "$OUT_DIR"

if ! command -v xcaddy >/dev/null 2>&1; then
  echo "xcaddy is required. Install with: go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest" >&2
  exit 1
fi

build_one() {
  local goos="$1"
  local goarch="$2"
  local suffix="$3"
  echo "=> building supacloud-caddy-${suffix}"
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 xcaddy build "$CADDY_VERSION" \
    --with "$RATE_LIMIT_MODULE" \
    --output "$OUT_DIR/supacloud-caddy-${suffix}"
  chmod 0755 "$OUT_DIR/supacloud-caddy-${suffix}"
}

build_one linux amd64 linux-amd64
build_one linux arm64 linux-arm64

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && sha256sum supacloud-caddy-linux-amd64 supacloud-caddy-linux-arm64 > SHA256SUMS.caddy)
fi

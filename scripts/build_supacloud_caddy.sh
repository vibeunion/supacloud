#!/usr/bin/env bash
set -euo pipefail

CADDY_VERSION="${CADDY_VERSION:-v2.11.4}"
XCADDY_VERSION="${XCADDY_VERSION:-v0.4.5}"
RATE_LIMIT_MODULE_VERSION="${RATE_LIMIT_MODULE_VERSION:-5625512f24f6f59d6f64fb3aafe5eecff0b286db}"
RATE_LIMIT_MODULE="${RATE_LIMIT_MODULE:-github.com/mholt/caddy-ratelimit@${RATE_LIMIT_MODULE_VERSION}}"
OUT_DIR="${OUT_DIR:-dist}"
mkdir -p "$OUT_DIR"

if [[ "$RATE_LIMIT_MODULE" != *@* ]]; then
  echo "RATE_LIMIT_MODULE must include an immutable @version or @commit" >&2
  exit 1
fi

if ! command -v xcaddy >/dev/null 2>&1; then
  echo "xcaddy is required. Install with: go install github.com/caddyserver/xcaddy/cmd/xcaddy@${XCADDY_VERSION}" >&2
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

#!/usr/bin/env bash
set -euo pipefail

CADDY_VERSION="${CADDY_VERSION:-v2.11.7}"
GO_VERSION="${GO_VERSION:-1.27.1}"
XCADDY_VERSION="${XCADDY_VERSION:-v0.4.7}"
RATE_LIMIT_MODULE_VERSION="${RATE_LIMIT_MODULE_VERSION:-5625512f24f6f59d6f64fb3aafe5eecff0b286db}"
RATE_LIMIT_MODULE="${RATE_LIMIT_MODULE:-github.com/mholt/caddy-ratelimit@${RATE_LIMIT_MODULE_VERSION}}"
CACHE_MODULE_VERSION="${CACHE_MODULE_VERSION:-07d7af2130699eb840e1f4ed49ef817da4201c2e}"
CACHE_MODULE="${CACHE_MODULE:-github.com/caddyserver/cache-handler@${CACHE_MODULE_VERSION}}"
CACHE_STORAGE_MODULE_VERSION="${CACHE_STORAGE_MODULE_VERSION:-81250fe6fc63358ff9f12faa72b01f36e48ed60c}"
CACHE_STORAGE_MODULE="${CACHE_STORAGE_MODULE:-github.com/darkweak/storages/simplefs/caddy@${CACHE_STORAGE_MODULE_VERSION}}"
BADGER_STORAGE_MODULE_VERSION="${BADGER_STORAGE_MODULE_VERSION:-v0.0.23}"
BADGER_STORAGE_MODULE="${BADGER_STORAGE_MODULE:-github.com/darkweak/storages/badger/caddy@${BADGER_STORAGE_MODULE_VERSION}}"
CADDY_BUILD_TARGETS="${CADDY_BUILD_TARGETS:-linux-amd64 linux-arm64}"
OUT_DIR="${OUT_DIR:-dist}"
mkdir -p "$OUT_DIR"

if [[ "$RATE_LIMIT_MODULE" != *@* ]]; then
  echo "RATE_LIMIT_MODULE must include an immutable @version or @commit" >&2
  exit 1
fi
if [[ "$CACHE_MODULE" != *@* ]]; then
  echo "CACHE_MODULE must include an immutable @version or @commit" >&2
  exit 1
fi
if [[ "$CACHE_STORAGE_MODULE" != *@* ]]; then
  echo "CACHE_STORAGE_MODULE must include an immutable @version or @commit" >&2
  exit 1
fi
if [[ "$BADGER_STORAGE_MODULE" != *@* ]]; then
  echo "BADGER_STORAGE_MODULE must include an immutable @version or @commit" >&2
  exit 1
fi

if ! command -v xcaddy >/dev/null 2>&1; then
  echo "xcaddy is required. Install with: GOTOOLCHAIN=go${GO_VERSION} go install github.com/caddyserver/xcaddy/cmd/xcaddy@${XCADDY_VERSION}" >&2
  exit 1
fi

xcaddy_version="$(xcaddy version)"
if [[ "${xcaddy_version%% *}" != "$XCADDY_VERSION" ]]; then
  echo "xcaddy ${XCADDY_VERSION} is required; found ${xcaddy_version%% *}. Install with: GOTOOLCHAIN=go${GO_VERSION} go install github.com/caddyserver/xcaddy/cmd/xcaddy@${XCADDY_VERSION}" >&2
  exit 1
fi

# Use the same compiler as release and Docker builds, even on older Go hosts.
export GOTOOLCHAIN="go${GO_VERSION}"
go version

build_one() {
  local goos="$1"
  local goarch="$2"
  local suffix="$3"
  echo "=> building supacloud-caddy-${suffix}"
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 xcaddy build "$CADDY_VERSION" \
    --with "$RATE_LIMIT_MODULE" \
    --with "$CACHE_MODULE" \
    --with "$CACHE_STORAGE_MODULE" \
    --with "$BADGER_STORAGE_MODULE" \
    --output "$OUT_DIR/supacloud-caddy-${suffix}"
  chmod 0755 "$OUT_DIR/supacloud-caddy-${suffix}"
}

read -r -a targets <<<"$CADDY_BUILD_TARGETS"
if [[ "${#targets[@]}" -eq 0 ]]; then
  echo "CADDY_BUILD_TARGETS must include at least one target" >&2
  exit 1
fi
built_binaries=()
for target in "${targets[@]}"; do
  case "$target" in
    linux-amd64) build_one linux amd64 linux-amd64 ;;
    linux-arm64) build_one linux arm64 linux-arm64 ;;
    *) echo "Unsupported Caddy build target: $target" >&2; exit 1 ;;
  esac
  built_binaries+=("supacloud-caddy-$target")
done

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && sha256sum "${built_binaries[@]}" > SHA256SUMS.caddy)
fi

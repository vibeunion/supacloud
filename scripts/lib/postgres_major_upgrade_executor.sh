#!/usr/bin/env bash
# SupaCloud PostgreSQL major-upgrade executor contract.
#
# The Management API deliberately does not guess whether a deployment is
# Pigsty/Patroni, Docker, or a separately managed PostgreSQL cluster. Configure
# SUPACLOUD_POSTGRES_MAJOR_UPGRADE_EXECUTOR with an absolute, root-owned provider
# executable. This wrapper validates the state-machine arguments and delegates
# the provider-specific preflight/execute/rollback operation.

set -euo pipefail

ACTION="${1:-}"
shift || true
UPGRADE_ID=""
CURRENT_MAJOR=""
TARGET_MAJOR=""
FENCING_TOKEN=""

while (($# > 0)); do
  case "$1" in
    --upgrade-id) UPGRADE_ID="${2:-}"; shift 2 ;;
    --current-major) CURRENT_MAJOR="${2:-}"; shift 2 ;;
    --target-major) TARGET_MAJOR="${2:-}"; shift 2 ;;
    --fencing-token) FENCING_TOKEN="${2:-}"; shift 2 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ "$ACTION" =~ ^(preflight|execute|rollback)$ ]] || { echo "invalid upgrade action" >&2; exit 2; }
[[ "$UPGRADE_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "invalid upgrade id" >&2; exit 2; }
[[ "$CURRENT_MAJOR" =~ ^(14|15|16|17|18)$ ]] || { echo "invalid current major" >&2; exit 2; }
[[ "$TARGET_MAJOR" =~ ^(14|15|16|17|18)$ ]] || { echo "invalid target major" >&2; exit 2; }
(( TARGET_MAJOR > CURRENT_MAJOR )) || { echo "target major must be newer" >&2; exit 2; }
[[ "$FENCING_TOKEN" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "invalid fencing token" >&2; exit 2; }

PROVIDER="${SUPACLOUD_POSTGRES_MAJOR_UPGRADE_PROVIDER_EXECUTOR:-}"
if [[ ! "$PROVIDER" =~ ^/[A-Za-z0-9_./-]+$ || "$PROVIDER" == *..* || ! -x "$PROVIDER" ]]; then
  echo "provider executor is not configured as an executable absolute path" >&2
  exit 78
fi
[[ "$PROVIDER" != "$0" ]] || { echo "provider executor cannot point to the contract wrapper" >&2; exit 78; }

PROVIDER_REAL="$(realpath -- "$PROVIDER" 2>/dev/null || true)"
WRAPPER_REAL="$(realpath -- "$0" 2>/dev/null || true)"
[[ -n "$PROVIDER_REAL" && "$PROVIDER_REAL" != "$WRAPPER_REAL" ]] || {
  echo "provider executor cannot resolve to the contract wrapper" >&2
  exit 78
}
case "$PROVIDER_REAL" in
  /opt/supacloud/scripts/lib/*|/usr/local/libexec/supacloud/*) ;;
  *) echo "provider executor must resolve inside a trusted directory" >&2; exit 78 ;;
esac
[[ "$(stat -c '%u' -- "$PROVIDER_REAL" 2>/dev/null || true)" == "0" ]] || {
  echo "provider executor must be owned by root" >&2
  exit 78
}
PROVIDER_MODE="$(stat -c '%a' -- "$PROVIDER_REAL" 2>/dev/null || true)"
[[ "$PROVIDER_MODE" =~ ^[0-7]{3,4}$ ]] || { echo "cannot inspect provider executor mode" >&2; exit 78; }
(( (8#$PROVIDER_MODE & 8#22) == 0 )) || { echo "provider executor must not be group/world writable" >&2; exit 78; }

exec "$PROVIDER" "$ACTION" \
  --upgrade-id "$UPGRADE_ID" \
  --current-major "$CURRENT_MAJOR" \
  --target-major "$TARGET_MAJOR" \
  --fencing-token "$FENCING_TOKEN"

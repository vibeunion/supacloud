#!/usr/bin/env bash
# Read actual configs through the full watchdog; all service calls stay local.
set -euo pipefail
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WATCHDOG="${SUPACLOUD_WATCHDOG_TEST_SCRIPT:-$ROOT_DIR/scripts/postgrest_watchdog.sh}"
REAL_HEAD=$(command -v head)
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/tenants" "$TMP_DIR/state"
printf 'server-port = 3158\n' > "$TMP_DIR/tenants/healthy.conf"
cat > "$TMP_DIR/bin/curl" <<'SH'
#!/usr/bin/env bash
for arg in "$@"; do last="$arg"; done
printf '%s\n' "$last" >> "$PROBE_LOG"
printf 200
SH
cat > "$TMP_DIR/bin/head" <<'SH'
#!/usr/bin/env bash
is_target=0
if [[ -e /proc/self/fd/0 ]]; then
    [[ "$(stat -L -c '%d:%i' /proc/self/fd/0)" == "$(stat -c '%d:%i' "$MUTATE_CONFIG")" ]] && is_target=1
else
    [[ "$(stat -L -f '%i' /dev/fd/0)" == "$(stat -f '%i' "$MUTATE_CONFIG")" ]] && is_target=1
fi
if [[ "$is_target" == 1 && "$READ_SCENARIO" == partial-failure ]]; then
    printf 'server-port = 3157\n'
    exit 1
fi
if [[ "$is_target" == 1 && "$READ_SCENARIO" == mutation ]]; then
    chmod 666 "$MUTATE_CONFIG"
    printf 'server-port = 9999\n' > "$MUTATE_CONFIG"
fi
exec "$REAL_HEAD" "$@"
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP_DIR/bin/logger"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP_DIR/bin/journalctl"
chmod 755 "$TMP_DIR/bin/"*
fail() { echo "$*" >&2; exit 1; }

for scenario in valid nul partial-failure mutation oversized; do
  config="$TMP_DIR/tenants/broken.conf"
  chmod 600 "$config" 2>/dev/null || true
  printf 'server-port = 3157\n' > "$config"
  case "$scenario" in
    nul) printf 'server-port = 31\00057\n' > "$config" ;;
    oversized) printf '#%065536d\n' 0 >> "$config" ;;
  esac
  rm -f "$TMP_DIR/state/broken.state" "$TMP_DIR/state/healthy.state"
  : > "$TMP_DIR/probes"
  status=0
  # Fault injection targets the bad tenant only, by checking stdin's inode.
  PATH="$TMP_DIR/bin:/usr/bin:/bin" REAL_HEAD="$REAL_HEAD" \
    READ_SCENARIO="$scenario" MUTATE_CONFIG="$config" PROBE_LOG="$TMP_DIR/probes" \
    SUPACLOUD_WATCHDOG_STATE_DIR="$TMP_DIR/state" \
    SUPACLOUD_TENANT_CONFIG_DIR="$TMP_DIR/tenants" SUPACLOUD_ALERT_WEBHOOK_URL="" \
    bash "$WATCHDOG" || status=$?
  if [[ "$scenario" == valid ]]; then
    [[ "$status" == 0 && "$(cat "$TMP_DIR/state/broken.state")" == ok ]] || fail 'Valid configuration was rejected'
  else
    [[ "$status" == 1 ]] || fail "$scenario configuration did not fail closed (exit $status)"
    [[ "$(cat "$TMP_DIR/state/broken.state")" != ok ]] || fail "$scenario configuration was accepted"
    ! grep -q ':3157/\|:9999/' "$TMP_DIR/probes" || fail "$scenario configuration was probed"
  fi
  [[ "$(cat "$TMP_DIR/state/healthy.state")" == ok ]] || fail "$scenario prevented the healthy tenant from being checked"
done

echo 'postgrest_watchdog_config_read.test.sh: OK (valid, NUL, read failure, mutation, size)'

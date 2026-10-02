#!/usr/bin/env bash
# Exercise webhook arguments and failure isolation without external services.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WATCHDOG="${SUPACLOUD_WATCHDOG_TEST_SCRIPT:-$ROOT_DIR/scripts/postgrest_watchdog.sh}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/tenants" "$TMP_DIR/state"
printf 'server-port = 3157\n' > "$TMP_DIR/tenants/first.conf"
printf 'server-port = 3158\n' > "$TMP_DIR/tenants/second.conf"

cat > "$TMP_DIR/bin/curl" <<'SH'
#!/usr/bin/env bash
for arg in "$@"; do last="$arg"; done
case "$last" in
  https://hooks.example/alert)
    printf '%s\n' "$@" > "$WEBHOOK_ARGS"
    printf 'webhook\n' >> "$WEBHOOK_CALLS"
    exit "${WEBHOOK_EXIT:-0}"
    ;;
  http://127.0.0.1:3157/) printf '503' ;;
  http://127.0.0.1:3158/) printf '200' ;;
  *) exit 99 ;;
esac
SH
cat > "$TMP_DIR/bin/journalctl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat > "$TMP_DIR/bin/logger" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ALERT_LOG"
SH
chmod 755 "$TMP_DIR/bin/"*

fail() { echo "$*" >&2; exit 1; }
argument_after() {
  awk -v key="$1" '$0 == key { getline; print; exit }' "$TMP_DIR/args"
}
check_webhook() {
  local raw="$1" expected="$2" webhook_exit="${3:-0}" status=0
  rm -f "$TMP_DIR/state/first.state" "$TMP_DIR/state/second.state"
  : > "$TMP_DIR/args"
  : > "$TMP_DIR/calls"
  : > "$TMP_DIR/alerts"
  (
    if [[ "$raw" == unset ]]; then
      unset SUPACLOUD_WATCHDOG_WEBHOOK_TIMEOUT
    else
      export SUPACLOUD_WATCHDOG_WEBHOOK_TIMEOUT="$raw"
    fi
    PATH="$TMP_DIR/bin:/usr/bin:/bin" \
      WEBHOOK_ARGS="$TMP_DIR/args" WEBHOOK_CALLS="$TMP_DIR/calls" \
      WEBHOOK_EXIT="$webhook_exit" ALERT_LOG="$TMP_DIR/alerts" \
      SUPACLOUD_ALERT_WEBHOOK_URL='https://hooks.example/alert' \
      SUPACLOUD_WATCHDOG_STATE_DIR="$TMP_DIR/state" \
      SUPACLOUD_TENANT_CONFIG_DIR="$TMP_DIR/tenants" \
      bash "$WATCHDOG"
  ) || status=$?
  [[ "$status" == 1 ]] || fail "Expected incident exit 1, got $status for '$raw'"
  [[ "$(head -n 1 "$TMP_DIR/args")" == -q ]] || fail 'Webhook must disable curlrc before any other curl option'
  [[ "$(argument_after --connect-timeout)" == "$expected" ]] || fail "Wrong connect timeout for '$raw'"
  [[ "$(argument_after --max-time)" == "$expected" ]] || fail "Wrong total timeout for '$raw'"
  [[ "$(argument_after -X)" == POST ]] || fail 'Webhook method changed'
  [[ "$(wc -l < "$TMP_DIR/calls")" -eq 1 ]] || fail 'Webhook was retried or not sent'
  [[ "$(cat "$TMP_DIR/state/first.state")" == http-503\|* ]] || fail 'Incident state was lost'
  [[ "$(cat "$TMP_DIR/state/second.state")" == ok ]] || fail 'Webhook prevented the later tenant from being checked'
  if [[ "$webhook_exit" != 0 ]]; then
    grep -q 'webhook delivery failed for first' "$TMP_DIR/alerts" || fail 'Webhook failure was not logged'
  fi
}

check_webhook unset 5
check_webhook '' 5
check_webhook 1 1
check_webhook 7 7
for value in 0 -1 01 1.5 invalid ' 3'; do check_webhook "$value" 5; done
check_webhook 2 2 28
check_webhook 2 2 22

echo 'postgrest_watchdog_webhook.test.sh: OK (12 timeout and failure-isolation cases)'

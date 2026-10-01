#!/usr/bin/env bash
# Guards the PostgREST tenant watchdog probe semantics.
# A reachable PostgREST answers 401/404 to an unauthenticated root probe and must
# be treated as healthy; only a failed connection or a 5xx is an incident.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/tenants" "$TMP_DIR/state"

printf 'server-port = 3157\n' > "$TMP_DIR/tenants/demo.conf"

cat > "$TMP_DIR/bin/curl" <<'SH'
#!/usr/bin/env bash
printf '%s' "${CURL_CODE:-}"
SH

cat > "$TMP_DIR/bin/journalctl" <<'SH'
#!/usr/bin/env bash
printf '%s' "${JOURNAL_TEXT:-}"
SH

cat > "$TMP_DIR/bin/logger" <<'SH'
#!/usr/bin/env bash
exit 0
SH

chmod 755 "$TMP_DIR/bin/"*

run_watchdog() {
  PATH="$TMP_DIR/bin:/usr/bin:/bin" \
    CURL_CODE="$1" JOURNAL_TEXT="$2" \
    SUPACLOUD_WATCHDOG_STATE_DIR="$TMP_DIR/state" \
    SUPACLOUD_TENANT_CONFIG_DIR="$TMP_DIR/tenants" \
    SUPACLOUD_ALERT_WEBHOOK_URL="" \
    bash "$ROOT_DIR/scripts/postgrest_watchdog.sh"
}

state_value() {
  cat "$TMP_DIR/state/demo.state"
}

expect_healthy() {
  local code="$1" label="$2"
  rm -f "$TMP_DIR/state/demo.state"
  if ! run_watchdog "$code" ""; then
    echo "watchdog reported ${label} (HTTP ${code}) as an incident" >&2
    exit 1
  fi
  if [[ "$(state_value)" != "ok" ]]; then
    echo "watchdog did not record healthy state for ${label} (HTTP ${code}): $(state_value)" >&2
    exit 1
  fi
}

expect_incident() {
  local code="$1" journal="$2" expected="$3" label="$4"
  rm -f "$TMP_DIR/state/demo.state"
  if run_watchdog "$code" "$journal"; then
    echo "watchdog accepted ${label} as healthy" >&2
    exit 1
  fi
  if [[ "$(state_value)" != "$expected"* ]]; then
    echo "unexpected watchdog state for ${label}: $(state_value)" >&2
    exit 1
  fi
}

# Reachable PostgREST responses, including the unauthenticated 401 root probe.
expect_healthy "200" "ok probe"
expect_healthy "401" "unauthenticated root probe"
expect_healthy "404" "missing root route"

# Failed connections and server errors.
expect_incident "" "" "http-|" "connection failure"
expect_incident "503" "" "http-503|" "service unavailable"
expect_incident "500" "" "http-500|" "internal server error"

# Reachable but the journal exposes a schema-cache failure.
expect_incident "200" "PGRST002 could not load the schema cache" "journal-error|" "schema-cache failure"

echo "postgrest_watchdog.test.sh: OK"
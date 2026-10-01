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
for arg in "$@"; do last="$arg"; done
[[ -n "${PROBE_LOG:-}" ]] && printf '%s\n' "$last" >> "$PROBE_LOG"
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

run_watchdog_in() {
  local tenants="$1" code="$2" journal="$3"
  PATH="$TMP_DIR/bin:/usr/bin:/bin" \
    CURL_CODE="$code" JOURNAL_TEXT="$journal" PROBE_LOG="$TMP_DIR/probe.log" \
    SUPACLOUD_WATCHDOG_STATE_DIR="$TMP_DIR/state" \
    SUPACLOUD_TENANT_CONFIG_DIR="$tenants" \
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

# Generation layout: the watchdog must probe <ref>_postgrest.current ->
# <ref>_postgrest.d/<sha>.conf like the PostgREST launcher does, instead of the
# legacy <ref>.conf that may be stale or absent.
GEN_DIR="$TMP_DIR/gen"
BROKEN_DIR="$TMP_DIR/broken"
GEN_SHA=$(printf 'a%.0s' {1..64})
mkdir -p "$GEN_DIR/genonly_postgrest.d" "$GEN_DIR/genlegacy_postgrest.d" "$BROKEN_DIR/broken_postgrest.d"
printf 'server-port = 3135\n' > "$GEN_DIR/genonly_postgrest.d/${GEN_SHA}.conf"
printf 'genonly_postgrest.d/%s.conf\n' "$GEN_SHA" > "$GEN_DIR/genonly_postgrest.current"
printf 'server-port = 3136\n' > "$GEN_DIR/genlegacy_postgrest.d/${GEN_SHA}.conf"
printf 'genlegacy_postgrest.d/%s.conf\n' "$GEN_SHA" > "$GEN_DIR/genlegacy_postgrest.current"
printf 'server-port = 9999\n' > "$GEN_DIR/genlegacy.conf"
printf 'broken_postgrest.d/%s.conf\n' "$GEN_SHA" > "$BROKEN_DIR/broken_postgrest.current"

: > "$TMP_DIR/probe.log"
rm -f "$TMP_DIR/state/genonly.state" "$TMP_DIR/state/genlegacy.state"
if run_watchdog_in "$GEN_DIR" "401" ""; then
  :
else
  echo "watchdog reported a healthy generation-layout tenant as an incident" >&2
  exit 1
fi
if [[ "$(cat "$TMP_DIR/state/genonly.state")" != "ok" ]]; then
  echo "generation-only tenant was not probed: $(cat "$TMP_DIR/state/genonly.state" 2>/dev/null)" >&2
  exit 1
fi
if [[ "$(cat "$TMP_DIR/state/genlegacy.state")" != "ok" ]]; then
  echo "generation-layout tenant with legacy conf was not probed" >&2
  exit 1
fi
grep -q ':3135/' "$TMP_DIR/probe.log" || { echo "generation-only tenant probed on the wrong port" >&2; exit 1; }
grep -q ':3136/' "$TMP_DIR/probe.log" || { echo "generation-layout tenant probed on the wrong port" >&2; exit 1; }
if grep -q ':9999/' "$TMP_DIR/probe.log"; then
  echo "watchdog probed the stale legacy conf for a generation-layout tenant" >&2
  exit 1
fi

# A pointer that does not resolve fails closed instead of being silently skipped.
rm -f "$TMP_DIR/state/broken.state"
if run_watchdog_in "$BROKEN_DIR" "401" ""; then
  echo "watchdog accepted an unresolvable PostgREST pointer" >&2
  exit 1
fi
[[ "$(cat "$TMP_DIR/state/broken.state" 2>/dev/null)" == missing-config* ]] \
  || { echo "unresolvable pointer did not fail closed: $(cat "$TMP_DIR/state/broken.state" 2>/dev/null)" >&2; exit 1; }

echo "postgrest_watchdog.test.sh: OK"
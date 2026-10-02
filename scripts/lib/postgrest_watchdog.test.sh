#!/usr/bin/env bash
# Exercise real watchdog control flow with deterministic local service probes.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WATCHDOG="${SUPACLOUD_WATCHDOG_TEST_SCRIPT:-$ROOT_DIR/scripts/postgrest_watchdog.sh}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/tenants" "$TMP_DIR/state"
printf 'server-port = 3157\n' > "$TMP_DIR/tenants/demo.conf"

cat > "$TMP_DIR/bin/curl" <<'SH'
#!/usr/bin/env bash
for arg in "$@"; do last="$arg"; done
printf '%s\n' "$last" >> "${PROBE_LOG:-/dev/null}"
printf '%s\n' "$*" >> "${CURL_LOG:-/dev/null}"
printf '%s' "${CURL_CODE:-}"
exit "${CURL_EXIT:-0}"
SH
cat > "$TMP_DIR/bin/journalctl" <<'SH'
#!/usr/bin/env bash
printf '%s' "${JOURNAL_TEXT:-}"
SH
cat > "$TMP_DIR/bin/logger" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ALERT_LOG"
SH
chmod 755 "$TMP_DIR/bin/"*

run_watchdog_in() {
  local tenants="$1" code="$2" journal="$3" curl_exit="${4:-0}"
  PATH="$TMP_DIR/bin:/usr/bin:/bin" \
    CURL_CODE="$code" CURL_EXIT="$curl_exit" JOURNAL_TEXT="$journal" \
    PROBE_LOG="$TMP_DIR/probe.log" ALERT_LOG="$TMP_DIR/alert.log" \
    SUPACLOUD_WATCHDOG_STATE_DIR="$TMP_DIR/state" \
    SUPACLOUD_TENANT_CONFIG_DIR="$tenants" \
    SUPACLOUD_ALERT_WEBHOOK_URL="" \
    timeout 10 bash "$WATCHDOG"
}

state_value() { cat "$TMP_DIR/state/${1:-demo}.state"; }
fail() { echo "$*" >&2; exit 1; }
expect_healthy() {
  local code="$1"
  rm -f "$TMP_DIR/state/demo.state"
  run_watchdog_in "$TMP_DIR/tenants" "$code" "" || fail "HTTP $code reported as an incident"
  [[ "$(state_value)" == ok ]] || fail "HTTP $code did not record healthy state"
}
expect_incident() {
  local code="$1" journal="$2" expected="$3" curl_exit="${4:-0}" status=0
  rm -f "$TMP_DIR/state/demo.state"
  run_watchdog_in "$TMP_DIR/tenants" "$code" "$journal" "$curl_exit" || status=$?
  [[ "$status" == 1 ]] || fail "Expected incident exit 1, got $status for HTTP $code / curl $curl_exit"
  [[ "$(state_value)" == "$expected"* ]] || fail "Unexpected incident: $(state_value)"
}

# Complete reachable responses need no credentials; 1xx is not a final response.
for code in 200 204 301 401 403 404 429; do expect_healthy "$code"; done
for code in '' 000 500 503 599 999 invalid 200200; do
  expect_incident "$code" "" "http-${code}|"
done
# A transfer can fail after receiving a nominally healthy response header.
expect_incident 200 "" 'http-200|' 28
expect_incident 401 "" 'http-401|' 18
expect_incident 000 "" 'http-000|' 7
expect_incident 100 "" 'http-100|'
expect_incident 200 'PGRST002 could not load the schema cache' 'journal-error|'
expect_incident 401 'Failed to load the schema cache' 'journal-error|'
expect_incident 404 'schema "pgmq_public" does not exist' 'journal-error|'

# Repeated incidents are deduplicated and recovery is emitted exactly once.
rm -f "$TMP_DIR/state/demo.state"
: > "$TMP_DIR/alert.log"
for attempt in 1 2; do
  status=0
  run_watchdog_in "$TMP_DIR/tenants" 503 "" || status=$?
  [[ "$status" == 1 ]] || fail "Incident $attempt was not reported"
done
[[ "$(grep -c '\[critical\]' "$TMP_DIR/alert.log")" == 1 ]] || fail "Repeated incident was not deduplicated"
run_watchdog_in "$TMP_DIR/tenants" 401 ""
run_watchdog_in "$TMP_DIR/tenants" 200 ""
[[ "$(grep -c '\[recovered\]' "$TMP_DIR/alert.log")" == 1 ]] || fail "Recovery was not emitted exactly once"

GEN_SHA=$(printf 'a%.0s' {1..64})
make_generation() {
  local dir="$1" ref="$2" port="$3"
  mkdir -p "$dir/${ref}_postgrest.d"
  printf 'server-port = %s\n' "$port" > "$dir/${ref}_postgrest.d/${GEN_SHA}.conf"
  printf '%s_postgrest.d/%s.conf\n' "$ref" "$GEN_SHA" > "$dir/${ref}_postgrest.current"
}

# Generation-only tenants and pointers with stale legacy files use active ports.
# A .bak substring in the parent directory must not disable all monitoring.
GEN_DIR="$TMP_DIR/config.bak/location with spaces"
make_generation "$GEN_DIR" genonly 3135
make_generation "$GEN_DIR" genlegacy 3136
printf 'server-port = 9999\n' > "$GEN_DIR/genlegacy.conf"
: > "$TMP_DIR/probe.log"
run_watchdog_in "$GEN_DIR" 401 "" || fail 'Healthy generation tenant reported as an incident'
for ref in genonly genlegacy; do
  [[ "$(state_value "$ref")" == ok ]] || fail "Generation tenant $ref not watched"
done
for port in 3135 3136; do
  grep -q ":${port}/" "$TMP_DIR/probe.log" || fail "Active port $port not probed"
done
[[ "$(wc -l < "$TMP_DIR/probe.log")" -eq 2 ]] || fail 'Tenant was probed more than once'
! grep -q ':9999/' "$TMP_DIR/probe.log" || fail 'Stale legacy port was probed'

# Invalid pointers cannot fall back to healthy legacy configs. Special files
# must be rejected without a blocking read. Preserve the first healthy tenant
# check after each failure to ensure one bad tenant does not abort the loop.
for scenario in missing multiline no-newline traversal cross-tenant symlink-pointer dangling-pointer symlink-config symlink-directory fifo directory empty oversized crlf nul; do
  dir="$TMP_DIR/$scenario"
  make_generation "$dir" broken 3135
  make_generation "$dir" healthy 3136
  pointer="$dir/broken_postgrest.current"
  config="$dir/broken_postgrest.d/$GEN_SHA.conf"
  printf 'server-port = 9999\n' > "$dir/broken.conf"
  case "$scenario" in
    missing) rm "$config" ;;
    multiline) printf 'extra\n' >> "$pointer" ;;
    no-newline) printf 'broken_postgrest.d/%s.conf' "$GEN_SHA" > "$pointer" ;;
    traversal) printf '../outside.conf\n' > "$pointer" ;;
    cross-tenant) printf 'healthy_postgrest.d/%s.conf\n' "$GEN_SHA" > "$pointer" ;;
    symlink-pointer) mv "$pointer" "$dir/pointer-target"; ln -s pointer-target "$pointer" ;;
    dangling-pointer) rm "$pointer"; ln -s missing "$pointer" ;;
    symlink-config) mv "$config" "$dir/config-target"; ln -s ../config-target "$config" ;;
    symlink-directory) mv "$dir/broken_postgrest.d" "$dir/generation-target"; ln -s generation-target "$dir/broken_postgrest.d" ;;
    fifo) rm "$pointer"; mkfifo "$pointer" ;;
    directory) rm "$pointer"; mkdir "$pointer" ;;
    empty) : > "$pointer" ;;
    oversized) printf '%0200d\n' 0 > "$pointer" ;;
    crlf) printf 'broken_postgrest.d/%s.conf\r\n' "$GEN_SHA" > "$pointer" ;;
    nul) printf 'broken_postgrest.d/%s.conf\0\n' "$GEN_SHA" > "$pointer" ;;
  esac
  rm -f "$TMP_DIR/state/broken.state" "$TMP_DIR/state/healthy.state"
  : > "$TMP_DIR/probe.log"
  status=0
  run_watchdog_in "$dir" 401 "" || status=$?
  [[ "$status" == 1 ]] || fail "Invalid $scenario pointer did not fail closed (exit $status)"
  [[ "$(state_value broken)" == missing-config\|* ]] || fail "$scenario pointer: $(state_value broken)"
  [[ "$(state_value healthy)" == ok ]] || fail "$scenario pointer prevented other tenants from being watched"
  [[ "$(wc -l < "$TMP_DIR/probe.log")" -eq 1 ]] || fail "$scenario pointer was probed or fell back to legacy"
  grep -q ':3136/' "$TMP_DIR/probe.log" || fail "$scenario: wrong tenant probed"
done

# Invalid project refs must not enter regexes, line-oriented records or state paths.
INVALID_DIR="$TMP_DIR/invalid-refs"
make_generation "$INVALID_DIR" 'bad.ref' 9999
printf 'server-port = 9999\n' > "$INVALID_DIR/backup.bak.conf"
printf 'server-port = 9999\n' > "$INVALID_DIR/$(printf 'bad\tref').conf"
: > "$TMP_DIR/probe.log"
run_watchdog_in "$INVALID_DIR" 401 ""
[[ ! -s "$TMP_DIR/probe.log" ]] || fail 'An invalid project ref was probed'
mkdir -p "$TMP_DIR/no-tenants"
run_watchdog_in "$TMP_DIR/no-tenants" 200 ""
printf '# no port\n' > "$TMP_DIR/tenants/demo.conf"
expect_incident 200 "" 'missing-port|'

# Alert webhook delivery must be bounded so a stalled endpoint cannot hold the
# watchdog open and delay the remaining tenants. Assert the actual bounds, the
# environment override and the invalid-value fallback.
run_webhook() {
  local configured="$1" log="$2" status=0
  : > "$log"
  rm -f "$TMP_DIR/state/demo.state"
  PATH="$TMP_DIR/bin:/usr/bin:/bin" \
    CURL_CODE=503 CURL_LOG="$log" PROBE_LOG="$TMP_DIR/probe.log" \
    ALERT_LOG="$TMP_DIR/alert.log" \
    SUPACLOUD_ALERT_WEBHOOK_URL='https://hooks.example/alert' \
    SUPACLOUD_WATCHDOG_WEBHOOK_TIMEOUT="$configured" \
    SUPACLOUD_WATCHDOG_STATE_DIR="$TMP_DIR/state" \
    SUPACLOUD_TENANT_CONFIG_DIR="$TMP_DIR/tenants" \
    timeout 10 bash "$WATCHDOG" || status=$?
  [[ "$status" == 1 ]] || fail "webhook scenario did not report the incident (exit $status)"
  grep -q 'hooks.example/alert' "$log" || fail 'alert webhook was not delivered'
}

run_webhook "" "$TMP_DIR/webhook.log"
grep 'hooks.example/alert' "$TMP_DIR/webhook.log" | grep -q -- '--connect-timeout 5' \
  || fail 'default webhook connect timeout is not 5'
grep 'hooks.example/alert' "$TMP_DIR/webhook.log" | grep -q -- '--max-time 5' \
  || fail 'default webhook total timeout is not 5'

run_webhook '9' "$TMP_DIR/webhook-override.log"
grep 'hooks.example/alert' "$TMP_DIR/webhook-override.log" | grep -q -- '--connect-timeout 9' \
  || fail 'webhook connect-timeout override was not honored'
grep 'hooks.example/alert' "$TMP_DIR/webhook-override.log" | grep -q -- '--max-time 9' \
  || fail 'webhook total timeout override was not honored'

run_webhook 'not-a-number' "$TMP_DIR/webhook-invalid.log"
grep 'hooks.example/alert' "$TMP_DIR/webhook-invalid.log" | grep -q -- '--connect-timeout 5' \
  || fail 'invalid webhook timeout did not fall back to 5 (connect)'
grep 'hooks.example/alert' "$TMP_DIR/webhook-invalid.log" | grep -q -- '--max-time 5' \
  || fail 'invalid webhook timeout did not fall back to 5 (total)'

echo 'postgrest_watchdog.test.sh: OK (transport, HTTP, journal, state transitions and config boundaries)'

#!/usr/bin/env bash
# Exercise real watchdog control flow with deterministic local service probes.
set -euo pipefail

# `timeout` is GNU coreutils; a stock macOS only has it via gtimeout, if at all.
# Resolve an absolute path before the tests narrow PATH, then expose a portable
# wrapper so the regression runs unchanged on Linux and macOS. When neither tool
# exists, terminate the command's process group so descendants cannot retain
# captured output pipes and hang the suite after their parent has exited.
WATCHDOG_TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
timeout() (
    local seconds="$1"
    shift
    if [[ -n "$WATCHDOG_TIMEOUT_BIN" ]]; then
        "$WATCHDOG_TIMEOUT_BIN" "$seconds" "$@"
        return
    fi
    # Isolate job-control changes to this subshell. Each background job gets its
    # own process group, so descendants holding captured pipes are also stopped.
    set -m
    local pid watcher status=0
    "$@" &
    pid=$!
    (
        # Keep the sleeper in the watcher's group for cancellation on completion.
        set +m
        sleep "$seconds"
        kill -TERM -- "-$pid" 2>/dev/null || true
        sleep 2
        kill -KILL -- "-$pid" 2>/dev/null || true
    ) &
    watcher=$!
    wait "$pid" 2>/dev/null || status=$?
    kill -TERM -- "-$watcher" 2>/dev/null || true
    wait "$watcher" 2>/dev/null || true
    # The parent may terminate before a descendant that ignores SIGTERM.
    kill -KILL -- "-$pid" 2>/dev/null || true
    return "$status"
)

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WATCHDOG="${SUPACLOUD_WATCHDOG_TEST_SCRIPT:-$ROOT_DIR/scripts/postgrest_watchdog.sh}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/tenants" "$TMP_DIR/state"
printf 'server-port = 3157\n' > "$TMP_DIR/tenants/demo.conf"

cat > "$TMP_DIR/bin/curl" <<'SH'
#!/usr/bin/env bash
for arg in "$@"; do last="$arg"; done
printf '%s\n' "$last" >> "$PROBE_LOG"
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

# Force the fallback on every platform. Capture output just like the Bun bridge:
# a surviving descendant or timer sleeper would keep these pipes open.
saved_timeout_bin="$WATCHDOG_TIMEOUT_BIN"
WATCHDOG_TIMEOUT_BIN=""
for scenario in direct descendants ignores-term; do
  fallback_start=$(date +%s)
  status=0
  case "$scenario" in
    direct) fallback_output="$(timeout 1 sleep 30)" || status=$? ;;
    descendants) fallback_output="$(timeout 1 bash -c 'sleep 30 & wait')" || status=$? ;;
    ignores-term) fallback_output="$(timeout 1 bash -c 'trap "" TERM; sleep 30 & wait')" || status=$? ;;
  esac
  fallback_elapsed=$(( $(date +%s) - fallback_start ))
  [[ "$status" != 0 ]] || fail "bounded fallback did not terminate $scenario"
  [[ "$fallback_elapsed" -le 6 ]] || fail "bounded fallback exceeded its bound for $scenario (${fallback_elapsed}s)"
done
fallback_start=$(date +%s)
fallback_output="$(timeout 10 bash -c 'sleep 30 & printf done')"
[[ "$fallback_output" == done ]] || fail 'fallback lost successful command output'
[[ $(( $(date +%s) - fallback_start )) -le 6 ]] || fail 'fallback retained a descendant or timer after successful completion'
status=0
fallback_output="$(timeout 10 bash -c 'exit 7')" || status=$?
[[ "$status" == 7 ]] || fail "fallback changed command exit status to $status"
WATCHDOG_TIMEOUT_BIN="$saved_timeout_bin"

# Escalation must SIGKILL a command that ignores SIGTERM. A pure-bash busy loop
# traps TERM and has no child, so termination proves the SIGKILL path.
WATCHDOG_TIMEOUT_BIN=""
kill_start=$(date +%s)
status=0
timeout 1 bash -c 'trap "" TERM; while :; do :; done' || status=$?
kill_elapsed=$(( $(date +%s) - kill_start ))
WATCHDOG_TIMEOUT_BIN="$saved_timeout_bin"
[[ "$status" != 0 ]] || fail 'escalating fallback did not terminate a SIGTERM-ignoring command'
[[ "$kill_elapsed" -le 8 ]] || fail "escalating fallback exceeded its bound (${kill_elapsed}s)"

echo 'postgrest_watchdog.test.sh: OK (transport, HTTP, journal, state transitions and config boundaries)'

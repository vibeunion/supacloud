#!/usr/bin/env bash
# Exercises the deploy-side PostgreSQL major-upgrade provider without a server.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PROVIDER="$ROOT/scripts/lib/postgres_major_upgrade_provider.sh"
BASH_BIN=$(command -v bash)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

UPGRADE_ID="11111111-1111-4111-8111-111111111111"
FENCING_TOKEN="22222222-2222-4222-8222-222222222222"
OTHER_UPGRADE_ID="33333333-3333-4333-8333-333333333333"

DEPLOY_ROOT=""
DATA_DIR=""
WORK_DIR=""
PROFILE=""
BIN_ROOT=""
PG17_BIN=""
PG18_BIN=""
PGPASSWORD=""
JWT_SECRET=""
STDOUT=""
STDERR=""

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  printf 'stdout: %s\nstderr: %s\n' "$STDOUT" "$STDERR" >&2
  exit 1
}

run() {
  local stdout_file stderr_file code
  stdout_file=$(mktemp)
  stderr_file=$(mktemp)
  set +e
  env -i \
    PATH=/usr/bin:/bin \
    HOME="$TMP" \
    TMPDIR="$TMP" \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PGPASSWORD="$PGPASSWORD" \
    JWT_SECRET="$JWT_SECRET" \
    SUPACLOUD_DEPLOY_ROOT="$DEPLOY_ROOT" \
    SUPACLOUD_POSTGRES_DATA_DIR="$DATA_DIR" \
    SUPACLOUD_POSTGRES_UPGRADE_WORK_DIR="$WORK_DIR" \
    SUPACLOUD_POSTGRES_UPGRADE_PROFILE="$PROFILE" \
    SUPACLOUD_PG_BIN_ROOT="$BIN_ROOT" \
    SUPACLOUD_PG17_BIN="$PG17_BIN" \
    SUPACLOUD_PG18_BIN="$PG18_BIN" \
    "$BASH_BIN" "$PROVIDER" "$@" >"$stdout_file" 2>"$stderr_file"
  code=$?
  STDOUT=$(cat "$stdout_file")
  STDERR=$(cat "$stderr_file")
  rm -f "$stdout_file" "$stderr_file"
  return "$code"
}

expect_code() {
  local expected="$1"
  shift
  local code
  set +e
  run "$@"
  code=$?
  set -e
  [[ "$code" -eq "$expected" ]] || fail "exit ${code}, expected ${expected} for: $*"
}

json_eq() {
  python3 - "$STDOUT" "$1" "$2" <<'PY' || fail "json ${1} != ${2}"
import json
import sys
data = json.loads(sys.argv[1])
cur = data
for part in sys.argv[2].split("."):
    if "[" in part:
        name, index = part[:-1].split("[")
        cur = cur[name][int(index)]
    else:
        cur = cur[part]
expected = json.loads(sys.argv[3])
if cur != expected:
    raise SystemExit(f"{sys.argv[2]}={cur!r} expected {expected!r}")
PY
}

has_blocker() {
  python3 - "$STDOUT" "$1" <<'PY'
import json
import sys
data = json.loads(sys.argv[1])
sys.exit(0 if sys.argv[2] in data["blockers"] else 1)
PY
}

assert_unmeasured() {
  json_eq schema '"supacloud.postgres-major-upgrade-executor.v1"'
  json_eq measured 'false'
  json_eq real_major_upgrade '"unmeasured"'
  json_eq restore_verified 'false'
  json_eq cutover_verified 'false'
  json_eq rollback_verified 'false'
  json_eq scope '"cluster"'
  json_eq cluster_scope 'true'
  json_eq strategy '"new-datadir-or-volume"'
  json_eq 'steps[7].id' '"cutover"'
  json_eq 'steps[7].status' '"unmeasured"'
  json_eq notes '["A real PostgreSQL major upgrade was not measured.","This executor does not delete Docker volumes and does not reuse a data directory across major versions.","Replication, PrivateLink, and metering are out of scope.","Cluster cutover is not performed."]'
  python3 - "$STDOUT" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
assert len(data["steps"]) == 8, data["steps"]
live = {data["profile"]["volumes"]["docker_self_host"], data["profile"]["volumes"]["docker_dev"]}
planned = set(data["profile"]["target_volumes"].values())
assert live.isdisjoint(planned), (live, planned)
assert "postgres-data" not in planned
PY
}

reset_context() {
  DEPLOY_ROOT=""
  DATA_DIR="$TMP/missing-data-dir"
  WORK_DIR=""
  PROFILE=""
  BIN_ROOT=""
  PG17_BIN=""
  PG18_BIN=""
  PGPASSWORD=""
  JWT_SECRET=""
}

make_fixture() {
  local root="$1"
  local major="${2:-17}"
  mkdir -p "$root/docker/self-host/postgres" "$root/docker/dev" "$root/data"
  printf 'PG_VERSION=%s\nPOSTGRES_PASSWORD=super-secret-fixture\n' "$major" > "$root/config.env"
  printf 'FROM postgres:18-bookworm\n' > "$root/docker/self-host/postgres/Dockerfile"
  printf '      - postgres-data:/var/lib/postgresql\n' > "$root/docker/self-host/docker-compose.yml"
  printf '      - pgdata18:/var/lib/postgresql\n' > "$root/docker/dev/docker-compose.yml"
  printf '%s\n' "$major" > "$root/data/PG_VERSION"
}

make_bins() {
  local root="$1"
  local env_log="$2"
  local major tool
  for major in 17 18; do
    mkdir -p "$root/$major/bin"
    for tool in postgres initdb pg_upgrade; do
      cat > "$root/$major/bin/$tool" <<EOF
#!/bin/sh
env >> $(printf '%q' "$env_log")
printf '%s %s\n' "$major/$tool" "\$*" >> $(printf '%q' "$root/argv.log")
if [ "\$1" = "--version" ]; then
  printf 'postgres (PostgreSQL) %s.0\n' "$major"
  exit 0
fi
printf '%s %s\n' "$major/$tool" "\$*"
if [ "$tool" = "initdb" ]; then
  dir=""
  while [ \$# -gt 0 ]; do
    if [ "\$1" = "-D" ]; then
      dir=\$2
      shift 2
      continue
    fi
    shift
  done
  mkdir -p "\$dir"
  printf '%s\n' "$major" > "\$dir/PG_VERSION"
fi
exit 0
EOF
      chmod 755 "$root/$major/bin/$tool"
    done
  done
}

bash -n "$PROVIDER"
bash -n "$ROOT/scripts/lib/postgres_major_upgrade_executor.sh"

python3 - "$PROVIDER" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
for key in ("measured", "restore_verified", "cutover_verified", "rollback_verified"):
    if re.search(rf'"{key}"\s*:\s*True', text):
        raise SystemExit(f"{key} can be claimed true")
if '"real_major_upgrade": "unmeasured"' not in text:
    raise SystemExit("missing unmeasured marker")
PY

reset_context
expect_code 0 plan --current-major 17 --target-major 18 --deploy-root "$ROOT"
[[ -z "$STDERR" ]] || fail "plan wrote stderr: $STDERR"
assert_unmeasured
json_eq profile.kind '"declared"'
json_eq profile.declared_major '18'
json_eq profile.docker_image_major '18'
json_eq profile.volumes.docker_self_host '"postgres-data"'
json_eq profile.volumes.docker_dev '"pgdata18"'
json_eq profile.target_volumes.docker_self_host '"postgres-data-pg18"'
json_eq profile.target_volumes.docker_dev '"pgdata18-upgrade"'
json_eq execution '"dry-run"'
json_eq source_unchanged 'true'
has_blocker real-major-upgrade-unmeasured
has_blocker isolated-work-dir-missing
if [[ ! -x /usr/lib/postgresql/17/bin/postgres || ! -x /usr/lib/postgresql/18/bin/postgres ]]; then
  has_blocker postgres-binaries-missing
fi
[[ "$STDOUT" != *POSTGRES_PASSWORD* ]] || fail "plan leaked config.env"

reset_context
expect_code 2 plan --current-major 18 --target-major 18
[[ -z "$STDOUT" ]] || fail "invalid plan emitted JSON"
expect_code 2 plan --current-major 18 --target-major 19
expect_code 2 preflight --current-major 17 --target-major 18 --upgrade-id not-a-uuid --fencing-token "$FENCING_TOKEN"
expect_code 0 --help
[[ "$STDERR" == *"unmeasured"* ]] || fail "help does not mention unmeasured"

FIXTURE="$TMP/fixture"
make_fixture "$FIXTURE" 17
DATA_DIR="$FIXTURE/data"
DEPLOY_ROOT="$FIXTURE"
PGPASSWORD="super-secret-fixture"
JWT_SECRET="jwt-secret-fixture"
before=$(md5sum "$FIXTURE/data/PG_VERSION" "$FIXTURE/config.env")
expect_code 0 plan --current-major 17 --target-major 18 --deploy-root "$FIXTURE"
assert_unmeasured
json_eq profile.kind '"pigsty"'
json_eq profile.declared_major '17'
json_eq profile.data_directory_major '17'
[[ "$STDOUT" != *super-secret-fixture* && "$STDERR" != *super-secret-fixture* ]] || fail "secret leaked into plan"
[[ "$STDOUT" != *jwt-secret-fixture* ]] || fail "jwt leaked into plan"
after=$(md5sum "$FIXTURE/data/PG_VERSION" "$FIXTURE/config.env")
[[ "$before" == "$after" ]] || fail "plan modified the fixture"

expect_code 78 preflight --upgrade-id "$UPGRADE_ID" --current-major 17 --target-major 18 --fencing-token "$FENCING_TOKEN" --deploy-root "$FIXTURE"
[[ "$STDERR" == *"real major upgrade unmeasured"* ]] || fail "preflight stderr: $STDERR"
assert_unmeasured
json_eq upgrade_id '"'"$UPGRADE_ID"'"'
json_eq fencing_token '"'"$FENCING_TOKEN"'"'
[[ ! -e "$FIXTURE/data/target" ]] || fail "preflight created a target"

printf '16\n' > "$FIXTURE/data/PG_VERSION"
expect_code 0 plan --current-major 17 --target-major 18 --deploy-root "$FIXTURE"
has_blocker data-directory-major-mismatch
json_eq 'steps[1].status' '"failed"'
expect_code 1 execute --upgrade-id "$UPGRADE_ID" --current-major 17 --target-major 18 --fencing-token "$FENCING_TOKEN" --deploy-root "$FIXTURE"
[[ "$(tr -d '[:space:]' < "$FIXTURE/data/PG_VERSION")" == "16" ]] || fail "execute rewrote the deploy data directory"
json_eq cutover_verified 'false'
printf '17\n' > "$FIXTURE/data/PG_VERSION"

PROFILE="docker-self-host"
expect_code 1 execute --upgrade-id "$UPGRADE_ID" --current-major 15 --target-major 16 --fencing-token "$FENCING_TOKEN" --deploy-root "$FIXTURE"
has_blocker docker-image-major-mismatch
json_eq cutover_verified 'false'
PROFILE=""

WORK_DIR="/pg/supacloud-major-upgrade-drill"
PG17_BIN="$TMP/bins/17/bin"
PG18_BIN="$TMP/bins/18/bin"
ENV_LOG="$TMP/tool.env"
make_bins "$TMP/bins" "$ENV_LOG"
expect_code 78 execute --upgrade-id "$UPGRADE_ID" --current-major 17 --target-major 18 --fencing-token "$FENCING_TOKEN" --work-dir "$WORK_DIR"
has_blocker isolated-work-dir-untrusted
if [[ -f "$TMP/bins/argv.log" ]] && grep -q 'initdb' "$TMP/bins/argv.log"; then
  fail "untrusted work dir ran initdb"
fi
rm -f "$TMP/bins/argv.log" "$ENV_LOG"

ln -s "$FIXTURE/data" "$TMP/source-link"
DRILL="$TMP/drill"
mkdir -p "$DRILL"
ln -s "$FIXTURE/data" "$DRILL/source"
WORK_DIR="$DRILL"
DATA_DIR="$FIXTURE/data"
expect_code 1 execute --upgrade-id "$UPGRADE_ID" --current-major 17 --target-major 18 --fencing-token "$FENCING_TOKEN" --deploy-root "$FIXTURE" --work-dir "$DRILL"
has_blocker drill-source-symlink
if [[ -f "$TMP/bins/argv.log" ]] && grep -q 'pg_upgrade' "$TMP/bins/argv.log"; then
  fail "symlink source reached pg_upgrade"
fi
[[ "$(cat "$FIXTURE/data/PG_VERSION")" == "17" ]] || fail "symlink drill changed deploy PG_VERSION"
rm -rf "$DRILL"

DRILL=$(mktemp -d "$TMP/drill.XXXXXX")
mkdir -p "$DRILL/source"
printf '17\n' > "$DRILL/source/PG_VERSION"
WORK_DIR="$DRILL"
PGPASSWORD="super-secret-fixture"
JWT_SECRET="jwt-secret-fixture"
expect_code 78 execute --upgrade-id "$UPGRADE_ID" --current-major 17 --target-major 18 --fencing-token "$FENCING_TOKEN" --deploy-root "$FIXTURE" --work-dir "$DRILL"
assert_unmeasured
json_eq execution '"isolated-drill"'
json_eq drill_prepared 'true'
json_eq transfer_check '"passed"'
json_eq 'steps[4].status' '"done"'
json_eq 'steps[5].status' '"done"'
json_eq 'steps[7].status' '"unmeasured"'
[[ "$(cat "$DRILL/target/PG_VERSION")" == "18" ]] || fail "drill target major"
[[ "$(cat "$DRILL/source/PG_VERSION")" == "17" ]] || fail "drill source major changed"
[[ "$(cat "$FIXTURE/data/PG_VERSION")" == "17" ]] || fail "deploy data directory changed"
grep -q -- "--check" "$DRILL/pg_upgrade-check.log"
grep -q -- "$DRILL/source" "$DRILL/pg_upgrade-check.log"
grep -q -- "$DRILL/target" "$DRILL/pg_upgrade-check.log"
if grep -q -- "$FIXTURE/data" "$DRILL/pg_upgrade-check.log" "$TMP/bins/argv.log"; then
  fail "pg_upgrade saw the deploy data directory"
fi
if printf '%s\n' "$STDOUT" "$STDERR" | grep -q 'super-secret-fixture\|jwt-secret-fixture'; then
  fail "executor output contained a secret"
fi
if grep -q 'super-secret-fixture\|jwt-secret-fixture' "$ENV_LOG" "$DRILL/initdb.log" "$DRILL/pg_upgrade-check.log"; then
  fail "tool invocation received a secret"
fi
[[ "$STDERR" == *"real major upgrade unmeasured"* ]] || fail "execute stderr: $STDERR"

expect_code 78 rollback --upgrade-id "$OTHER_UPGRADE_ID" --current-major 17 --target-major 18 --fencing-token "$FENCING_TOKEN" --work-dir "$DRILL"
[[ -d "$DRILL/target" ]] || fail "rollback removed a different upgrade drill"
json_eq rollback_verified 'false'
json_eq drill_removed 'false'

expect_code 78 rollback --upgrade-id "$UPGRADE_ID" --current-major 17 --target-major 18 --fencing-token "$FENCING_TOKEN" --work-dir "$DRILL"
[[ ! -e "$DRILL/target" ]] || fail "rollback left the matching drill"
[[ -f "$DRILL/source/PG_VERSION" ]] || fail "rollback removed the disposable source"
[[ "$(cat "$FIXTURE/data/PG_VERSION")" == "17" ]] || fail "rollback changed the deploy data directory"
json_eq rollback_verified 'false'
json_eq drill_removed 'true'
json_eq execution '"drill-cleaned"'
json_eq real_major_upgrade '"unmeasured"'

grep -q '/opt/supacloud/scripts/lib/postgres_major_upgrade_provider.sh' "$ROOT/install.sh"
grep -q 'postgres_major_upgrade_provider.sh' "$ROOT/docker/dev/docker-compose.yml"
grep -q 'postgres_major_upgrade_provider.sh' "$ROOT/docker/self-host/docker-compose.yml"
grep -q 'scripts/lib/postgres_major_upgrade_provider.sh' "$ROOT/packages/management-api/Dockerfile"
grep -q 'scripts/lib/postgres_major_upgrade_provider.sh' "$ROOT/docker/self-host/management-api.Dockerfile"

printf 'ok\n'

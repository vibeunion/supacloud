#!/usr/bin/env bash
# Deploy-side PostgreSQL major-upgrade executor.
#
# The management API calls scripts/lib/postgres_major_upgrade_executor.sh, which
# delegates to this provider. This process reads the deploy representations
# already in the repository and on disk. It does not install PostgreSQL, delete
# a Docker volume, reuse a data directory across majors, or cut a cluster over.
#
# Representations:
#   Pigsty/native  config.env PG_VERSION, and PG_VERSION inside the data directory
#                  (SUPACLOUD_POSTGRES_DATA_DIR, or /pg/data when that file exists)
#   Docker image   docker/self-host/postgres/Dockerfile "FROM postgres:<major>"
#   Docker volumes docker/self-host postgres-data and docker/dev pgdata18,
#                  both mounted at /var/lib/postgresql
#
# Actions:
#   plan       Print one JSON plan. Exit 0. No PostgreSQL binaries required.
#   preflight  Same plan. Exit 78 until a measured restore drill exists.
#   execute    Run only inside an isolated work directory when binaries exist.
#              Exit 78 because cluster cutover stays unmeasured.
#   rollback   Delete this executor's isolated drill directory when the marker
#              matches. Exit 78 because cluster rollback stays unmeasured.
#
# Exit codes:
#   0   plan emitted
#   2   invalid arguments
#   78  real major upgrade unmeasured (no cluster cutover)
#   1   refused or the isolated drill failed
#
# A real major upgrade is unmeasured. measured, restore_verified,
# cutover_verified, and rollback_verified stay false.
#
# Isolated execute (never the deploy data directory):
#   SUPACLOUD_POSTGRES_UPGRADE_WORK_DIR=/tmp/pg-upgrade.XXXX
#   SUPACLOUD_PG17_BIN=/usr/lib/postgresql/17/bin
#   SUPACLOUD_PG18_BIN=/usr/lib/postgresql/18/bin
#   /tmp/pg-upgrade.XXXX/source/PG_VERSION    disposable copy, not a live volume
#   bash scripts/lib/postgres_major_upgrade_provider.sh execute \
#     --upgrade-id <uuid> --current-major 17 --target-major 18 \
#     --fencing-token <uuid>
#
# Direct plan:
#   bash scripts/lib/postgres_major_upgrade_provider.sh plan \
#     --current-major 17 --target-major 18

set -euo pipefail
umask 077

ACTION=""
UPGRADE_ID=""
FENCING_TOKEN=""
CURRENT_MAJOR=""
TARGET_MAJOR=""
DEPLOY_ROOT="${SUPACLOUD_DEPLOY_ROOT:-}"
REQUESTED_WORK_DIR="${SUPACLOUD_POSTGRES_UPGRADE_WORK_DIR:-}"
DATA_DIRECTORY="${SUPACLOUD_POSTGRES_DATA_DIR:-}"
PROFILE="${SUPACLOUD_POSTGRES_UPGRADE_PROFILE:-}"

STATE_DIR=""
WORK_REAL=""
TARGET_DATADIR=""
DECLARED_MAJOR=""
DATA_DIRECTORY_MAJOR=""
IMAGE_MAJOR=""
VOLUME_SELF_HOST=""
VOLUME_DEV=""
TARGET_VOLUME_SELF_HOST=""
TARGET_VOLUME_DEV=""
SOURCE_BIN=""
TARGET_BIN=""
EXECUTION="dry-run"
SOURCE_UNCHANGED="true"
DRILL_PREPARED="false"
DRILL_REMOVED="false"
TRANSFER_CHECK="skipped"
READ_DEPLOY_DETAIL=""
OBSERVED_STATE="absent"
OBSERVED_LINK=""

STEP_ORDER=(
  read-deploy
  match-majors
  refuse-datadir-reuse
  full-backup
  prepare-target
  transfer-check
  validate-pg-version
  cutover
)
declare -A STEP_STATUS=()
declare -A STEP_DETAIL=()
BLOCKERS=()

usage() {
  cat <<'EOF'
Usage: postgres_major_upgrade_provider.sh <plan|preflight|execute|rollback> [options]

Options:
  --upgrade-id <uuid>       Required for preflight, execute, and rollback
  --current-major <14-18>   Required
  --target-major <14-18>    Required and greater than --current-major
  --fencing-token <uuid>    Required for preflight, execute, and rollback
  --deploy-root <path>      Checkout used to read config.env and Docker files
  --work-dir <path>         Isolated /tmp or /var/tmp directory for a drill

Environment:
  SUPACLOUD_DEPLOY_ROOT
  SUPACLOUD_POSTGRES_DATA_DIR
  SUPACLOUD_POSTGRES_UPGRADE_WORK_DIR
  SUPACLOUD_POSTGRES_UPGRADE_PROFILE   pigsty|docker-self-host|docker-dev|declared|arguments
  SUPACLOUD_PG_BIN_ROOT                <root>/<major>/bin
  SUPACLOUD_PG14_BIN ... SUPACLOUD_PG18_BIN

Stdout is one JSON object. A real major upgrade is unmeasured.
EOF
}

die_args() {
  printf 'invalid upgrade arguments\n' >&2
  exit 2
}

require_value() {
  [[ $# -ge 2 && -n "${2:-}" ]] || die_args
}

add_blocker() {
  local item="$1"
  local existing
  if ((${#BLOCKERS[@]})); then
    for existing in "${BLOCKERS[@]}"; do
      [[ "$existing" == "$item" ]] && return 0
    done
  fi
  BLOCKERS+=("$item")
}

has_blocker() {
  local item="$1"
  local existing
  if ((${#BLOCKERS[@]})); then
    for existing in "${BLOCKERS[@]}"; do
      [[ "$existing" == "$item" ]] && return 0
    done
  fi
  return 1
}

set_step() {
  local detail="$3"
  detail=${detail//$'\t'/ }
  detail=${detail//$'\n'/ }
  STEP_STATUS["$1"]="$2"
  STEP_DETAIL["$1"]="$detail"
}

is_uuid() {
  [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
}

is_supported_major() {
  [[ "$1" =~ ^(14|15|16|17|18)$ ]]
}

clean_tool() {
  local home_dir="$1"
  shift
  env -i \
    PATH=/usr/bin:/bin \
    HOME="$home_dir" \
    TMPDIR="$home_dir" \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    "$@"
}

tool_in_bin() {
  local bin="$1"
  local tool="$2"
  local bin_real tool_real
  [[ "$bin" == /* && -x "$bin/$tool" ]] || return 1
  bin_real=$(realpath -e -- "$bin" 2>/dev/null || true)
  tool_real=$(realpath -e -- "$bin/$tool" 2>/dev/null || true)
  [[ -n "$bin_real" && -n "$tool_real" && "$tool_real" == "$bin_real"/* ]]
}

postgres_reported_major() {
  local bin="$1"
  local home_dir="$2"
  local output
  tool_in_bin "$bin" postgres || return 1
  output=$(clean_tool "$home_dir" "$bin/postgres" --version 2>/dev/null || true)
  [[ "$output" =~ ^postgres\ \(PostgreSQL\)\ ([0-9]+)([^0-9].*)?$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

bin_dir_for() {
  local major="$1"
  local var="SUPACLOUD_PG${major}_BIN"
  local configured="${!var:-}"
  if [[ "$configured" == /* ]]; then
    printf '%s\n' "$configured"
    return 0
  fi
  if [[ "${SUPACLOUD_PG_BIN_ROOT:-}" == /* ]]; then
    printf '%s\n' "${SUPACLOUD_PG_BIN_ROOT}/${major}/bin"
    return 0
  fi
  if [[ -x "/usr/lib/postgresql/${major}/bin/postgres" ]]; then
    printf '%s\n' "/usr/lib/postgresql/${major}/bin"
    return 0
  fi
  return 1
}

resolve_bin() {
  local major="$1"
  local home_dir="$2"
  local configured reported
  configured=$(bin_dir_for "$major" || true)
  [[ -n "$configured" ]] || return 1
  reported=$(postgres_reported_major "$configured" "$home_dir" || true)
  [[ "$reported" == "$major" ]] || return 1
  printf '%s\n' "$configured"
}

read_regular_major_file() {
  local file="$1"
  local value
  [[ -f "$file" && ! -L "$file" ]] || return 1
  value=$(tr -d '[:space:]' < "$file")
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$value"
}

read_declared_major() {
  local file="$1"
  local line value
  [[ -f "$file" && ! -L "$file" ]] || return 1
  line=$(grep -E '^PG_VERSION=' -- "$file" | head -n 1 || true)
  [[ -n "$line" ]] || return 1
  value=${line#PG_VERSION=}
  value=${value%\"}
  value=${value#\"}
  value=${value%\'}
  value=${value#\'}
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$value"
}

read_image_major() {
  local file="$1"
  local line
  [[ -f "$file" && ! -L "$file" ]] || return 1
  line=$(grep -E '^FROM postgres:[0-9]+' -- "$file" | head -n 1 || true)
  [[ "$line" =~ ^FROM\ postgres:([0-9]+) ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

volume_mounted() {
  local file="$1"
  local volume="$2"
  [[ -f "$file" && ! -L "$file" ]] || return 1
  grep -E "^[[:space:]]*-[[:space:]]*${volume}:/var/lib/postgresql[[:space:]]*$" -- "$file" >/dev/null
}

distinct_volume_name() {
  local name="$1"
  local suffix=0
  while [[ "$name" == "$VOLUME_SELF_HOST" || "$name" == "$VOLUME_DEV" || "$name" == "postgres-data" || "$name" == "pgdata${TARGET_MAJOR}" ]]; do
    suffix=$((suffix + 1))
    [[ "$suffix" -le 5 ]] || return 1
    name="${1}-next"
    if [[ "$suffix" -gt 1 ]]; then
      name="${1}-next${suffix}"
    fi
  done
  printf '%s\n' "$name"
}

path_is_protected() {
  local path="$1"
  case "$path" in
    /pg|/pg/*|/var/lib/postgresql|/var/lib/postgresql/*|/var/lib/supacloud|/var/lib/supacloud/*|/opt/supacloud|/opt/supacloud/*)
      return 0
      ;;
  esac
  return 1
}

work_dir_is_trusted() {
  local candidate="$1"
  local resolved parent deploy_real
  [[ "$candidate" == /* ]] || return 1
  [[ "$candidate" != *$'\n'* ]] || return 1
  local part
  IFS=/ read -r -a parts <<< "$candidate"
  for part in "${parts[@]}"; do
    [[ "$part" != "." && "$part" != ".." ]] || return 1
  done
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
  resolved=$(realpath -e -- "$candidate" 2>/dev/null || true)
  [[ -n "$resolved" && -d "$resolved" ]] || return 1
  case "$resolved" in
    /tmp/*|/var/tmp/*) ;;
    *) return 1 ;;
  esac
  path_is_protected "$resolved" && return 1
  if [[ -n "$DEPLOY_ROOT" ]]; then
    deploy_real=$(realpath -e -- "$DEPLOY_ROOT" 2>/dev/null || true)
    if [[ -n "$deploy_real" ]]; then
      case "$resolved" in
        "$deploy_real"|"$deploy_real"/*) return 1 ;;
      esac
    fi
  fi
  parent=$(dirname -- "$resolved")
  [[ "$parent" == "/tmp" || "$parent" == "/var/tmp" || "$parent" == /tmp/* || "$parent" == /var/tmp/* ]] || return 1
  WORK_REAL="$resolved"
  return 0
}

snapshot_observed() {
  OBSERVED_STATE="absent"
  OBSERVED_LINK=""
  [[ -n "$DATA_DIRECTORY" ]] || return 0
  if [[ -L "$DATA_DIRECTORY" ]]; then
    OBSERVED_LINK=$(readlink -- "$DATA_DIRECTORY" || true)
    printf '%s\n' "$OBSERVED_LINK" > "$STATE_DIR/observed-link"
    printf 'symlink\n' > "$STATE_DIR/observed-state"
    OBSERVED_STATE="symlink"
    return 0
  fi
  if [[ -f "$DATA_DIRECTORY/PG_VERSION" && ! -L "$DATA_DIRECTORY/PG_VERSION" ]]; then
    cp -p -- "$DATA_DIRECTORY/PG_VERSION" "$STATE_DIR/observed-pg-version"
    printf 'present\n' > "$STATE_DIR/observed-state"
    OBSERVED_STATE="present"
    return 0
  fi
  printf 'absent\n' > "$STATE_DIR/observed-state"
}

deploy_data_unchanged() {
  local state link
  [[ -f "$STATE_DIR/observed-state" ]] || return 0
  state=$(cat "$STATE_DIR/observed-state")
  case "$state" in
    absent)
      if [[ -n "$DATA_DIRECTORY" && -e "$DATA_DIRECTORY/PG_VERSION" ]]; then
        return 1
      fi
      ;;
    present)
      [[ -f "$DATA_DIRECTORY/PG_VERSION" && ! -L "$DATA_DIRECTORY/PG_VERSION" ]] || return 1
      cmp -s -- "$STATE_DIR/observed-pg-version" "$DATA_DIRECTORY/PG_VERSION" || return 1
      ;;
    symlink)
      [[ -L "$DATA_DIRECTORY" ]] || return 1
      link=$(readlink -- "$DATA_DIRECTORY" || true)
      [[ "$link" == "$(cat "$STATE_DIR/observed-link")" ]] || return 1
      ;;
  esac
  return 0
}

drill_source_ok() {
  local source_real major
  [[ -n "$WORK_REAL" ]] || return 1
  [[ -e "$WORK_REAL/source" ]] || return 1
  [[ ! -L "$WORK_REAL/source" && -d "$WORK_REAL/source" ]] || return 2
  source_real=$(realpath -e -- "$WORK_REAL/source" 2>/dev/null || true)
  [[ "$source_real" == "$WORK_REAL/source" ]] || return 2
  local link
  link=$(find "$source_real" -type l -print -quit || true)
  [[ -z "$link" ]] || return 2
  major=$(read_regular_major_file "$WORK_REAL/source/PG_VERSION" || true)
  [[ -n "$major" ]] || return 1
  [[ "$major" == "$CURRENT_MAJOR" ]] || return 3
  return 0
}

discover() {
  local script_dir candidate source_status
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [[ -z "$DEPLOY_ROOT" ]]; then
    candidate=$(cd "$script_dir/../.." && pwd)
    if [[ -f "$candidate/config.env" && ! -L "$candidate/config.env" ]]; then
      DEPLOY_ROOT="$candidate"
    fi
  elif [[ ! -d "$DEPLOY_ROOT" || -L "$DEPLOY_ROOT" ]]; then
    die_args
  fi

  if [[ -z "$DATA_DIRECTORY" && -f /pg/data/PG_VERSION && ! -L /pg/data && ! -L /pg/data/PG_VERSION ]]; then
    DATA_DIRECTORY=/pg/data
  fi
  if [[ -n "$DATA_DIRECTORY" && ! -e "$DATA_DIRECTORY" && ! -L "$DATA_DIRECTORY" ]]; then
    DATA_DIRECTORY=""
  fi

  if [[ -n "$DATA_DIRECTORY" ]]; then
    if [[ -L "$DATA_DIRECTORY" ]]; then
      add_blocker data-directory-symlink
    elif [[ -d "$DATA_DIRECTORY" ]]; then
      DATA_DIRECTORY_MAJOR=$(read_regular_major_file "$DATA_DIRECTORY/PG_VERSION" || true)
    fi
  fi

  if [[ -n "$DEPLOY_ROOT" ]]; then
    DECLARED_MAJOR=$(read_declared_major "$DEPLOY_ROOT/config.env" || true)
    IMAGE_MAJOR=$(read_image_major "$DEPLOY_ROOT/docker/self-host/postgres/Dockerfile" || true)
    if volume_mounted "$DEPLOY_ROOT/docker/self-host/docker-compose.yml" postgres-data; then
      VOLUME_SELF_HOST="postgres-data"
    fi
    if volume_mounted "$DEPLOY_ROOT/docker/dev/docker-compose.yml" pgdata18; then
      VOLUME_DEV="pgdata18"
    fi
  fi

  if [[ -z "$PROFILE" ]]; then
    if [[ -n "$DATA_DIRECTORY_MAJOR" ]]; then
      PROFILE="pigsty"
    elif [[ -n "$DECLARED_MAJOR" || -n "$IMAGE_MAJOR" || -n "$VOLUME_SELF_HOST" || -n "$VOLUME_DEV" ]]; then
      PROFILE="declared"
    else
      PROFILE="arguments"
    fi
  fi
  case "$PROFILE" in
    pigsty|docker-self-host|docker-dev|declared|arguments) ;;
    *) die_args ;;
  esac

  if [[ -n "$DATA_DIRECTORY_MAJOR" && "$DATA_DIRECTORY_MAJOR" != "$CURRENT_MAJOR" ]]; then
    add_blocker data-directory-major-mismatch
  fi
  if [[ "$PROFILE" == "docker-self-host" || "$PROFILE" == "docker-dev" ]]; then
    if [[ -z "$IMAGE_MAJOR" ]]; then
      add_blocker docker-image-major-missing
    elif [[ "$IMAGE_MAJOR" != "$TARGET_MAJOR" ]]; then
      add_blocker docker-image-major-mismatch
    fi
  fi

  TARGET_VOLUME_SELF_HOST=$(distinct_volume_name "postgres-data-pg${TARGET_MAJOR}") || add_blocker target-volume-collision
  TARGET_VOLUME_DEV=$(distinct_volume_name "pgdata${TARGET_MAJOR}-upgrade") || add_blocker target-volume-collision

  TARGET_BIN=$(resolve_bin "$TARGET_MAJOR" "$STATE_DIR" || true)
  SOURCE_BIN=$(resolve_bin "$CURRENT_MAJOR" "$STATE_DIR" || true)
  [[ -n "$TARGET_BIN" ]] || add_blocker postgres-binaries-missing
  [[ -n "$SOURCE_BIN" ]] || add_blocker source-binaries-missing
  if [[ -z "$TARGET_BIN" ]] || ! tool_in_bin "$TARGET_BIN" pg_upgrade; then
    add_blocker pg-upgrade-missing
  fi
  if [[ -z "$TARGET_BIN" ]] || ! tool_in_bin "$TARGET_BIN" initdb; then
    add_blocker initdb-missing
  fi

  if [[ -z "$REQUESTED_WORK_DIR" ]]; then
    add_blocker isolated-work-dir-missing
  elif ! work_dir_is_trusted "$REQUESTED_WORK_DIR"; then
    add_blocker isolated-work-dir-untrusted
  else
    TARGET_DATADIR="$WORK_REAL/target"
    source_status=0
    drill_source_ok || source_status=$?
    case "$source_status" in
      0) ;;
      1) add_blocker drill-source-missing ;;
      2) add_blocker drill-source-symlink ;;
      3) add_blocker drill-source-major-mismatch ;;
    esac
    if [[ -n "$DATA_DIRECTORY" ]]; then
      local data_real
      data_real=$(realpath -e -- "$DATA_DIRECTORY" 2>/dev/null || true)
      if [[ -n "$data_real" && "$data_real" == "$WORK_REAL" ]]; then
        add_blocker drill-source-aliases-data-directory
      fi
    fi
  fi

  add_blocker real-major-upgrade-unmeasured

  READ_DEPLOY_DETAIL="profile=${PROFILE}; declared=${DECLARED_MAJOR:-none}; data_directory_major=${DATA_DIRECTORY_MAJOR:-none}; docker_image_major=${IMAGE_MAJOR:-none}; self_host_volume=${VOLUME_SELF_HOST:-none}; dev_volume=${VOLUME_DEV:-none}"
}

assign_plan_steps() {
  local match_status="done"
  local match_detail="requested PostgreSQL ${CURRENT_MAJOR} to ${TARGET_MAJOR} matches the observed deploy representation"
  if has_blocker data-directory-major-mismatch || has_blocker docker-image-major-mismatch \
    || has_blocker docker-image-major-missing || has_blocker data-directory-symlink \
    || has_blocker drill-source-major-mismatch; then
    match_status="failed"
    match_detail="requested PostgreSQL ${CURRENT_MAJOR} to ${TARGET_MAJOR} does not match the deploy representation"
  fi
  set_step read-deploy done "$READ_DEPLOY_DETAIL"
  set_step match-majors "$match_status" "$match_detail"
  if [[ -n "$TARGET_DATADIR" ]]; then
    set_step refuse-datadir-reuse done "target ${TARGET_DATADIR} is a new directory; live data directories and Docker volumes are not reused"
  else
    set_step refuse-datadir-reuse planned "a major upgrade uses a new data directory or a new Docker volume and does not reuse postgres-data, pgdata${TARGET_MAJOR}, or the deploy data directory"
  fi
  set_step full-backup planned "the management API records the pgBackRest full backup before execute; this executor does not run backups"
  if has_blocker postgres-binaries-missing || has_blocker initdb-missing; then
    set_step prepare-target blocked "target PostgreSQL ${TARGET_MAJOR} initdb/postgres binaries were not found"
  elif has_blocker isolated-work-dir-missing || has_blocker isolated-work-dir-untrusted; then
    set_step prepare-target blocked "SUPACLOUD_POSTGRES_UPGRADE_WORK_DIR must be an isolated directory under /tmp or /var/tmp"
  else
    set_step prepare-target planned "initdb into the isolated work directory with the target major binaries"
  fi
  if has_blocker postgres-binaries-missing || has_blocker source-binaries-missing || has_blocker pg-upgrade-missing; then
    set_step transfer-check blocked "pg_upgrade --check needs the source and target PostgreSQL binaries"
  elif has_blocker isolated-work-dir-missing || has_blocker isolated-work-dir-untrusted || has_blocker drill-source-missing; then
    set_step transfer-check blocked "pg_upgrade --check runs only against a disposable \$WORK/source copy"
  elif has_blocker drill-source-symlink || has_blocker drill-source-major-mismatch || has_blocker drill-source-aliases-data-directory; then
    set_step transfer-check blocked "the disposable source copy must be a real directory inside the work directory"
  else
    set_step transfer-check planned "pg_upgrade --check from the disposable work/source into work/target"
  fi
  set_step validate-pg-version planned "target PG_VERSION must read ${TARGET_MAJOR} and the deploy data directory must stay unchanged"
  set_step cutover unmeasured "cluster cutover is not performed; a real major upgrade is unmeasured"
}

fatal_representation() {
  has_blocker data-directory-major-mismatch \
    || has_blocker data-directory-symlink \
    || has_blocker docker-image-major-mismatch \
    || has_blocker docker-image-major-missing \
    || has_blocker drill-source-major-mismatch \
    || has_blocker drill-source-symlink \
    || has_blocker drill-source-aliases-data-directory \
    || has_blocker target-volume-collision
}

run_isolated_drill() {
  local status target_major log
  [[ -n "$WORK_REAL" && -n "$TARGET_BIN" ]] || return 1
  tool_in_bin "$TARGET_BIN" initdb || return 1
  if [[ -e "$TARGET_DATADIR" || -L "$TARGET_DATADIR" ]]; then
    add_blocker target-already-exists
    set_step prepare-target failed "isolated target already exists"
    return 1
  fi
  log="$WORK_REAL/initdb.log"
  set +e
  clean_tool "$WORK_REAL" timeout 60 "$TARGET_BIN/initdb" \
    -D "$TARGET_DATADIR" \
    -U postgres \
    -A trust \
    --no-sync \
    --no-instructions \
    >"$log" 2>&1
  status=$?
  set -e
  if [[ "$status" -ne 0 || -L "$TARGET_DATADIR" || ! -d "$TARGET_DATADIR" ]]; then
    add_blocker initdb-failed
    set_step prepare-target failed "initdb into the isolated work directory failed"
    EXECUTION="isolated-drill-failed"
    return 1
  fi
  printf '%s\n' "$UPGRADE_ID" > "$TARGET_DATADIR/.supacloud-major-upgrade-drill"
  DRILL_PREPARED="true"
  set_step prepare-target done "initdb created an isolated PostgreSQL ${TARGET_MAJOR} data directory"
  target_major=$(read_regular_major_file "$TARGET_DATADIR/PG_VERSION" || true)
  if [[ "$target_major" != "$TARGET_MAJOR" ]]; then
    add_blocker target-pg-version-mismatch
    set_step validate-pg-version failed "isolated PG_VERSION is ${target_major:-missing}, expected ${TARGET_MAJOR}"
    EXECUTION="isolated-drill-failed"
    return 1
  fi

  if has_blocker source-binaries-missing || has_blocker pg-upgrade-missing || has_blocker drill-source-missing \
    || ! tool_in_bin "$TARGET_BIN" pg_upgrade || ! tool_in_bin "$SOURCE_BIN" postgres; then
    TRANSFER_CHECK="blocked"
    set_step validate-pg-version done "isolated PG_VERSION reads ${TARGET_MAJOR}; deploy data directory was not modified"
    EXECUTION="isolated-drill"
    return 0
  fi

  log="$WORK_REAL/pg_upgrade-check.log"
  set +e
  clean_tool "$WORK_REAL" timeout 60 "$TARGET_BIN/pg_upgrade" --check \
    --old-datadir "$WORK_REAL/source" \
    --new-datadir "$TARGET_DATADIR" \
    --old-bindir "$SOURCE_BIN" \
    --new-bindir "$TARGET_BIN" \
    >"$log" 2>&1
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    add_blocker pg-upgrade-check-failed
    TRANSFER_CHECK="failed"
    set_step transfer-check failed "pg_upgrade --check failed inside the isolated work directory"
    set_step validate-pg-version done "isolated PG_VERSION reads ${TARGET_MAJOR}; deploy data directory was not modified"
    EXECUTION="isolated-drill-failed"
    return 1
  fi
  TRANSFER_CHECK="passed"
  set_step transfer-check done "pg_upgrade --check passed for the isolated copy; cluster cutover was not performed"
  set_step validate-pg-version done "isolated PG_VERSION reads ${TARGET_MAJOR}; deploy data directory was not modified"
  EXECUTION="isolated-drill"
  return 0
}

remove_matching_drill() {
  local target marker resolved
  [[ -n "$WORK_REAL" ]] || return 0
  target="$WORK_REAL/target"
  [[ -e "$target" || -L "$target" ]] || return 0
  [[ ! -L "$target" && -d "$target" ]] || return 1
  resolved=$(realpath -e -- "$target" 2>/dev/null || true)
  [[ "$resolved" == "$WORK_REAL/target" ]] || return 1
  [[ -f "$target/.supacloud-major-upgrade-drill" && ! -L "$target/.supacloud-major-upgrade-drill" ]] || return 0
  marker=$(tr -d '[:space:]' < "$target/.supacloud-major-upgrade-drill")
  [[ "$marker" == "$UPGRADE_ID" ]] || return 0
  rm -rf -- "$resolved"
  DRILL_REMOVED="true"
  EXECUTION="drill-cleaned"
  set_step prepare-target done "removed the isolated drill directory for this upgrade id"
}

emit() {
  local code="$1"
  local reason="$2"
  local step blockers_file
  : > "$STATE_DIR/steps.tsv"
  for step in "${STEP_ORDER[@]}"; do
    [[ -n "${STEP_STATUS[$step]:-}" && -n "${STEP_DETAIL[$step]:-}" ]] || {
      printf 'executor plan is incomplete\n' >&2
      exit 1
    }
    printf '%s\t%s\t%s\n' "$step" "${STEP_STATUS[$step]}" "${STEP_DETAIL[$step]}" >> "$STATE_DIR/steps.tsv"
  done
  blockers_file="$STATE_DIR/blockers.txt"
  : > "$blockers_file"
  if ((${#BLOCKERS[@]})); then
    printf '%s\n' "${BLOCKERS[@]}" > "$blockers_file"
  fi
  EXEC_ACTION="$ACTION" \
  EXEC_UPGRADE_ID="$UPGRADE_ID" \
  EXEC_FENCING_TOKEN="$FENCING_TOKEN" \
  EXEC_CURRENT_MAJOR="$CURRENT_MAJOR" \
  EXEC_TARGET_MAJOR="$TARGET_MAJOR" \
  EXEC_PROFILE="$PROFILE" \
  EXEC_DECLARED_MAJOR="$DECLARED_MAJOR" \
  EXEC_DATA_DIRECTORY="$DATA_DIRECTORY" \
  EXEC_DATA_DIRECTORY_MAJOR="$DATA_DIRECTORY_MAJOR" \
  EXEC_IMAGE_MAJOR="$IMAGE_MAJOR" \
  EXEC_VOLUME_SELF_HOST="$VOLUME_SELF_HOST" \
  EXEC_VOLUME_DEV="$VOLUME_DEV" \
  EXEC_TARGET_VOLUME_SELF_HOST="$TARGET_VOLUME_SELF_HOST" \
  EXEC_TARGET_VOLUME_DEV="$TARGET_VOLUME_DEV" \
  EXEC_TARGET_DATADIR="$TARGET_DATADIR" \
  EXEC_DEPLOY_ROOT="$DEPLOY_ROOT" \
  EXEC_EXECUTION="$EXECUTION" \
  EXEC_SOURCE_UNCHANGED="$SOURCE_UNCHANGED" \
  EXEC_DRILL_PREPARED="$DRILL_PREPARED" \
  EXEC_DRILL_REMOVED="$DRILL_REMOVED" \
  EXEC_TRANSFER_CHECK="$TRANSFER_CHECK" \
  python3 - "$STATE_DIR" <<'PY'
import json
import os
import pathlib
import sys

state = pathlib.Path(sys.argv[1])

def optional_int(name):
    value = os.environ.get(name, "")
    return int(value) if value else None

def optional_text(name):
    value = os.environ.get(name, "")
    return value or None

def flag(name):
    return os.environ[name] == "true"

steps = []
for line in (state / "steps.tsv").read_text().splitlines():
    if not line:
        continue
    step_id, status, detail = line.split("\t", 2)
    steps.append({"id": step_id, "status": status, "detail": detail})

blockers = [line for line in (state / "blockers.txt").read_text().splitlines() if line]
payload = {
    "schema": "supacloud.postgres-major-upgrade-executor.v1",
    "executor": "supacloud-postgres-major-upgrade-provider",
    "action": os.environ["EXEC_ACTION"],
    "upgrade_id": optional_text("EXEC_UPGRADE_ID"),
    "fencing_token": optional_text("EXEC_FENCING_TOKEN"),
    "current_major": int(os.environ["EXEC_CURRENT_MAJOR"]),
    "target_major": int(os.environ["EXEC_TARGET_MAJOR"]),
    "scope": "cluster",
    "cluster_scope": True,
    "affects_all_projects": True,
    "strategy": "new-datadir-or-volume",
    "measured": False,
    "real_major_upgrade": "unmeasured",
    "restore_verified": False,
    "cutover_verified": False,
    "rollback_verified": False,
    "source_unchanged": flag("EXEC_SOURCE_UNCHANGED"),
    "execution": os.environ["EXEC_EXECUTION"],
    "drill_prepared": flag("EXEC_DRILL_PREPARED"),
    "drill_removed": flag("EXEC_DRILL_REMOVED"),
    "transfer_check": os.environ["EXEC_TRANSFER_CHECK"],
    "profile": {
        "kind": os.environ["EXEC_PROFILE"],
        "declared_major": optional_int("EXEC_DECLARED_MAJOR"),
        "data_directory": optional_text("EXEC_DATA_DIRECTORY"),
        "data_directory_major": optional_int("EXEC_DATA_DIRECTORY_MAJOR"),
        "docker_image_major": optional_int("EXEC_IMAGE_MAJOR"),
        "volumes": {
            "docker_self_host": optional_text("EXEC_VOLUME_SELF_HOST"),
            "docker_dev": optional_text("EXEC_VOLUME_DEV"),
        },
        "target_datadir": optional_text("EXEC_TARGET_DATADIR"),
        "target_volumes": {
            "docker_self_host": optional_text("EXEC_TARGET_VOLUME_SELF_HOST"),
            "docker_dev": optional_text("EXEC_TARGET_VOLUME_DEV"),
        },
    },
    "deploy_root": optional_text("EXEC_DEPLOY_ROOT"),
    "steps": steps,
    "blockers": blockers,
    "notes": [
        "A real PostgreSQL major upgrade was not measured.",
        "This executor does not delete Docker volumes and does not reuse a data directory across major versions.",
        "Replication, PrivateLink, and metering are out of scope.",
        "Cluster cutover is not performed.",
    ],
}
json.dump(payload, sys.stdout, separators=(",", ":"))
sys.stdout.write("\n")
PY
  if [[ "$code" -ne 0 ]]; then
    printf '%s\n' "$reason" >&2
  fi
  exit "$code"
}

finish() {
  if ! deploy_data_unchanged; then
    SOURCE_UNCHANGED="false"
    add_blocker deploy-data-directory-changed
    emit 1 "postgres major upgrade refused: deploy-data-directory-changed"
  fi
  emit "$@"
}

parse_args() {
  [[ $# -ge 1 ]] || die_args
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    usage >&2
    exit 0
  fi
  ACTION="$1"
  shift
  case "$ACTION" in
    plan|preflight|execute|rollback) ;;
    *) die_args ;;
  esac
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --upgrade-id)
        require_value "$@"
        UPGRADE_ID="$2"
        shift 2
        ;;
      --current-major)
        require_value "$@"
        CURRENT_MAJOR="$2"
        shift 2
        ;;
      --target-major)
        require_value "$@"
        TARGET_MAJOR="$2"
        shift 2
        ;;
      --fencing-token)
        require_value "$@"
        FENCING_TOKEN="$2"
        shift 2
        ;;
      --deploy-root)
        require_value "$@"
        DEPLOY_ROOT="$2"
        shift 2
        ;;
      --work-dir)
        require_value "$@"
        REQUESTED_WORK_DIR="$2"
        shift 2
        ;;
      *)
        die_args
        ;;
    esac
  done
  is_supported_major "$CURRENT_MAJOR" || die_args
  is_supported_major "$TARGET_MAJOR" || die_args
  [[ "$TARGET_MAJOR" -gt "$CURRENT_MAJOR" ]] || die_args
  if [[ "$ACTION" != "plan" ]]; then
    is_uuid "$UPGRADE_ID" || die_args
    is_uuid "$FENCING_TOKEN" || die_args
  else
    [[ -z "$UPGRADE_ID" || $(is_uuid "$UPGRADE_ID" && printf yes) == "yes" ]] || die_args
    [[ -z "$FENCING_TOKEN" || $(is_uuid "$FENCING_TOKEN" && printf yes) == "yes" ]] || die_args
  fi
}

main() {
  parse_args "$@"
  command -v python3 >/dev/null 2>&1 || {
    printf 'python3 is required to emit executor evidence\n' >&2
    exit 1
  }
  STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/supacloud-pg-upgrade.XXXXXX")
  trap 'rm -rf "$STATE_DIR"' EXIT
  discover
  snapshot_observed
  assign_plan_steps

  local reason="real major upgrade unmeasured"
  if fatal_representation; then
    reason="postgres major upgrade refused: representation mismatch"
    if [[ "$ACTION" == "plan" ]]; then
      finish 0 ""
    fi
    if [[ "$ACTION" == "rollback" && -n "$WORK_REAL" ]]; then
      remove_matching_drill || finish 1 "postgres major upgrade refused: drill cleanup failed"
    fi
    finish 1 "$reason"
  fi

  case "$ACTION" in
    plan)
      finish 0 ""
      ;;
    preflight)
      finish 78 "$reason"
      ;;
    rollback)
      if has_blocker isolated-work-dir-untrusted; then
        finish 78 "$reason"
      fi
      if [[ -n "$WORK_REAL" ]]; then
        remove_matching_drill || finish 1 "postgres major upgrade refused: drill cleanup failed"
      fi
      finish 78 "$reason"
      ;;
    execute)
      if has_blocker isolated-work-dir-missing || has_blocker isolated-work-dir-untrusted \
        || has_blocker postgres-binaries-missing || has_blocker initdb-missing; then
        finish 78 "$reason"
      fi
      if run_isolated_drill; then
        finish 78 "$reason"
      fi
      finish 1 "postgres major upgrade drill failed"
      ;;
  esac
}

main "$@"

#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPACLOUD_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CORE_SCRIPT="${SUPACLOUD_ROOT}/scripts/upgrade_pigsty_4_4_compat.sh"

MODE="check"
COMPOSE_FILE="${SUPACLOUD_DOCKER_COMPOSE_FILE:-${SUPACLOUD_ROOT}/docker/self-host/docker-compose.yml}"
PROJECT_DIR="${SUPACLOUD_DOCKER_PROJECT_DIR:-}"
ENV_FILE="${SUPACLOUD_DOCKER_ENV_FILE:-}"
BACKUP_DIR="${SUPACLOUD_DOCKER_BACKUP_DIR:-}"
POSTGRES_SERVICE="${SUPACLOUD_DOCKER_POSTGRES_SERVICE:-postgres}"
MANAGEMENT_SERVICE="${SUPACLOUD_DOCKER_MANAGEMENT_SERVICE:-management-api}"
EXPECTED_PG_MAJOR="${SUPACLOUD_DOCKER_EXPECTED_PG_MAJOR:-18}"
ASSUME_ANALYTICS_STOPPED="${SUPACLOUD_ASSUME_ANALYTICS_STOPPED:-false}"
SKIP_MANAGEMENT_INIT="${SUPACLOUD_DOCKER_SKIP_MANAGEMENT_INIT:-false}"

usage() {
  cat <<'EOF'
Usage: bash scripts/upgrade_postgres_docker_4_4_compat.sh [options] [mode]

Modes:
  --check                 Read-only compatibility verification (default).
  --dry-run               Show database targets and planned operations.
  --apply                 Create a logical backup, initialize metadata, and apply idempotent compatibility changes.
  --prepare-analytics     Offline-copy legacy Analytics after explicit writer-stop confirmation.
  --rollback-plan         Print safe Docker rollback guidance; does not change data.

Options:
  --compose-file <path>   Compose file (default: docker/self-host/docker-compose.yml).
  --project-directory <path>
                          Compose project directory (default: compose file directory).
  --env-file <path>       Optional Docker Compose env file (default: <project>/.env when present).
  --backup-dir <path>     Logical backup directory (default: <project>/backups).
  --expected-pg-major <n> Refuse a different running major version (default: 18).
  --assume-analytics-stopped
                          Required for Docker/external legacy Analytics migration after independently stopping writers.

Safety:
  - This script never runs `docker compose down -v` and never deletes a volume.
  - It does not perform an in-place PostgreSQL major upgrade.
  - PG17 -> PG18 requires dump/restore or pg_upgrade into a separately prepared data directory.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check|--dry-run|--apply|--prepare-analytics|--rollback-plan)
      MODE="${1#--}"
      shift
      ;;
    --compose-file)
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --project-directory)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --backup-dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    --expected-pg-major)
      EXPECTED_PG_MAJOR="$2"
      shift 2
      ;;
    --assume-analytics-stopped)
      ASSUME_ANALYTICS_STOPPED=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$MODE" == "rollback-plan" ]]; then
  cat <<'EOF'
Docker PostgreSQL rollback guidance:
1. Do not run `docker compose down -v`; preserve the current database volume.
2. Stop application writers before restoring data.
3. Prefer starting the previous image against its original same-major volume.
4. For PG17/PG18 transitions, create a new empty volume and restore the logical backup; never mount a PG17 data directory directly into PG18.
5. Keep publishable_key/secret_key_* columns during an application rollback; older binaries ignore them.
6. Keep the isolated _supabase database until its backup and the active Analytics target are verified.
7. Compatibility views/functions may be removed only after saving their definitions and confirming the previous Studio/Auth runtime requirements.
EOF
  exit 0
fi

[[ -f "$CORE_SCRIPT" ]] || {
  printf 'Compatibility core script not found: %s\n' "$CORE_SCRIPT" >&2
  exit 1
}
[[ -f "$COMPOSE_FILE" ]] || {
  printf 'Docker Compose file not found: %s\n' "$COMPOSE_FILE" >&2
  exit 1
}
[[ "$EXPECTED_PG_MAJOR" =~ ^[0-9]+$ ]] || {
  printf 'Invalid expected PostgreSQL major: %s\n' "$EXPECTED_PG_MAJOR" >&2
  exit 2
}

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  printf 'Docker Compose v2 is required.\n' >&2
  exit 1
fi

if [[ -z "$PROJECT_DIR" ]]; then
  PROJECT_DIR="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)"
fi
if [[ -z "$ENV_FILE" && -f "${PROJECT_DIR}/.env" ]]; then
  ENV_FILE="${PROJECT_DIR}/.env"
fi
if [[ -z "$BACKUP_DIR" ]]; then
  BACKUP_DIR="${PROJECT_DIR}/backups"
fi

COMPOSE=(docker compose --project-directory "$PROJECT_DIR" -f "$COMPOSE_FILE")
if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || {
    printf 'Docker Compose env file not found: %s\n' "$ENV_FILE" >&2
    exit 1
  }
  COMPOSE+=(--env-file "$ENV_FILE")
fi

compose_services="$("${COMPOSE[@]}" config --services)"
if ! grep -Fxq "$POSTGRES_SERVICE" <<< "$compose_services"; then
  printf 'PostgreSQL service %s is not defined in %s\n' "$POSTGRES_SERVICE" "$COMPOSE_FILE" >&2
  exit 1
fi
postgres_container="$("${COMPOSE[@]}" ps -q "$POSTGRES_SERVICE")"
if [[ -z "$postgres_container" ]]; then
  printf 'PostgreSQL service %s is not running. Start it before checking or applying compatibility.\n' "$POSTGRES_SERVICE" >&2
  exit 1
fi

POSTGRES_USER="$("${COMPOSE[@]}" exec -T "$POSTGRES_SERVICE" sh -lc 'printf %s "${POSTGRES_USER:-postgres}"')"
POSTGRES_DB="$("${COMPOSE[@]}" exec -T "$POSTGRES_SERVICE" sh -lc 'printf %s "${POSTGRES_DB:-postgres}"')"
version_num="$("${COMPOSE[@]}" exec -T "$POSTGRES_SERVICE" psql -X -Atq -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SHOW server_version_num')"
[[ "$version_num" =~ ^[0-9]+$ ]] || {
  printf 'Unable to determine the running PostgreSQL version.\n' >&2
  exit 1
}
running_major="$((10#$version_num / 10000))"
if [[ "$running_major" != "$EXPECTED_PG_MAJOR" ]]; then
  printf '[FAIL] Running PostgreSQL major is %s; this Docker profile expects %s.\n' "$running_major" "$EXPECTED_PG_MAJOR" >&2
  printf '       Do not reuse this volume across major versions. Use a new volume plus dump/restore or a planned pg_upgrade.\n' >&2
  exit 1
fi
printf '[PASS] Docker PostgreSQL major version: %s\n' "$running_major"

TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

write_compose_array() {
  local target="$1"
  printf 'compose=(' >> "$target"
  printf ' %q' "${COMPOSE[@]}" >> "$target"
  printf ' )\n' >> "$target"
}

create_postgres_proxy() {
  local target="$1"
  local tool="$2"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    write_compose_array /dev/stdout
    printf 'if [[ -n "${PGPASSWORD:-}" && -n "${ROLE_PASSWORD:-}" ]]; then\n'
    printf '  exec "${compose[@]}" exec -T -e PGPASSWORD -e ROLE_PASSWORD %q %q "$@"\n' "$POSTGRES_SERVICE" "$tool"
    printf 'elif [[ -n "${PGPASSWORD:-}" ]]; then\n'
    printf '  exec "${compose[@]}" exec -T -e PGPASSWORD %q %q "$@"\n' "$POSTGRES_SERVICE" "$tool"
    printf 'elif [[ -n "${ROLE_PASSWORD:-}" ]]; then\n'
    printf '  exec "${compose[@]}" exec -T -e ROLE_PASSWORD %q %q "$@"\n' "$POSTGRES_SERVICE" "$tool"
    printf 'else\n'
    printf '  exec "${compose[@]}" exec -T %q %q "$@"\n' "$POSTGRES_SERVICE" "$tool"
    printf 'fi\n'
  } > "$target"
  chmod 0700 "$target"
}

create_management_proxy() {
  local target="$1"
  local management_container=""
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    if [[ "$SKIP_MANAGEMENT_INIT" == "true" ]] || ! grep -Fxq "$MANAGEMENT_SERVICE" <<< "$compose_services"; then
      printf 'printf "[WARN] Docker management init was explicitly skipped or the service is unavailable.\\n" >&2\n'
      printf 'exit 0\n'
    else
      write_compose_array /dev/stdout
      management_container="$("${COMPOSE[@]}" ps -q "$MANAGEMENT_SERVICE")"
      if [[ -n "$management_container" ]]; then
        printf 'exec "${compose[@]}" exec -T %q bun run src/index.ts "$@"\n' "$MANAGEMENT_SERVICE"
      else
        printf 'exec "${compose[@]}" run --rm --no-deps %q bun run src/index.ts "$@"\n' "$MANAGEMENT_SERVICE"
      fi
    fi
  } > "$target"
  chmod 0700 "$target"
}

create_postgres_proxy "${TEMP_DIR}/psql" psql
create_postgres_proxy "${TEMP_DIR}/pg_dump" pg_dump
create_management_proxy "${TEMP_DIR}/supacloud"

create_backup() {
  mkdir -p "$BACKUP_DIR"
  chmod 0700 "$BACKUP_DIR"
  local timestamp backup_file temp_backup
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_file="${BACKUP_DIR}/supacloud-postgres-pre-4.4-compat-${timestamp}.sql"
  temp_backup="${backup_file}.tmp"
  umask 077
  printf '[INFO] Creating logical backup before Docker compatibility changes: %s\n' "$backup_file"
  if ! "${COMPOSE[@]}" exec -T "$POSTGRES_SERVICE" pg_dumpall -U "$POSTGRES_USER" > "$temp_backup"; then
    rm -f "$temp_backup"
    printf '[FAIL] Logical backup failed; no compatibility changes were applied.\n' >&2
    exit 1
  fi
  if [[ ! -s "$temp_backup" ]]; then
    rm -f "$temp_backup"
    printf '[FAIL] Logical backup is empty; no compatibility changes were applied.\n' >&2
    exit 1
  fi
  chmod 0600 "$temp_backup"
  mv "$temp_backup" "$backup_file"
  printf '[PASS] Logical backup created: %s\n' "$backup_file"
}

run_management_init() {
  if [[ "$SKIP_MANAGEMENT_INIT" == "true" ]]; then
    printf '[WARN] Skipping Docker management --init-db by explicit request.\n' >&2
    return 0
  fi
  if ! grep -Fxq "$MANAGEMENT_SERVICE" <<< "$compose_services"; then
    printf '[WARN] No %s service is defined; active projects with incomplete opaque keys will fail the final check.\n' "$MANAGEMENT_SERVICE" >&2
    return 0
  fi
  PATH="${TEMP_DIR}:$PATH" supacloud --init-db
}

if [[ "$MODE" == "prepare-analytics" && "$ASSUME_ANALYTICS_STOPPED" != "true" ]]; then
  printf '[FAIL] --prepare-analytics requires --assume-analytics-stopped after independently verifying all writers are stopped.\n' >&2
  exit 1
fi

if [[ "$MODE" == "apply" ]]; then
  create_backup
  run_management_init
elif [[ "$MODE" == "prepare-analytics" ]]; then
  create_backup
fi

export SUPACLOUD_COMPAT_PROFILE=docker
export SUPACLOUD_META_DB="${SUPACLOUD_META_DB:-$POSTGRES_DB}"
export LOGFLARE_DB_OWNER="${LOGFLARE_DB_OWNER:-$POSTGRES_USER}"
export SUPACLOUD_ASSUME_ANALYTICS_STOPPED="$ASSUME_ANALYTICS_STOPPED"
export SUPACLOUD_MANAGEMENT_ENV_FILE="${SUPACLOUD_MANAGEMENT_ENV_FILE:-${TEMP_DIR}/missing-management.env}"
export SUPACLOUD_COMPAT_PG_ENV_FILE="${SUPACLOUD_COMPAT_PG_ENV_FILE:-${TEMP_DIR}/missing-postgres.env}"
export PIGSTY_SUPABASE_ENV="${PIGSTY_SUPABASE_ENV:-${TEMP_DIR}/missing-pigsty.env}"
export PGBOUNCER_AUTH_FILE="${PGBOUNCER_AUTH_FILE:-${TEMP_DIR}/missing-pgbouncer-userlist.txt}"
export PGHOST="${PGHOST:-/var/run/postgresql}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-$POSTGRES_USER}"
export PSQL_BIN="${TEMP_DIR}/psql"
export PG_DUMP_BIN="${TEMP_DIR}/pg_dump"

PATH="${TEMP_DIR}:$PATH" bash "$CORE_SCRIPT" "--${MODE}"

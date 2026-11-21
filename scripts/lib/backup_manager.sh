#!/bin/bash

# backup_manager.sh
# Manage project database backups (based on Pigsty 4.x / pgBackRest)

set -euo pipefail

COMMAND=${1:-}
TARGET=${2:-}  # For pgBackRest, usually stanza name; for PITR, target time
OPTIONS=${3:-}

# Pigsty owns the physical backup implementation. SupaCloud only validates
# the provider state and exposes a stable, fail-closed operator interface.
STANZA="${SUPACLOUD_PGBACKREST_STANZA:-db-main}"
if [[ -z "${SUPACLOUD_PGBACKREST_STANZA:-}" && ( "$COMMAND" == "list" || "$COMMAND" == "create" ) && -n "$TARGET" ]]; then
    STANZA="$TARGET"
fi
BACKUP_USER="${SUPACLOUD_PGBACKREST_USER:-postgres}"
BACKUP_BIN="${SUPACLOUD_PGBACKREST_BIN:-pgbackrest}"
BACKUP_CONFIG="${SUPACLOUD_PGBACKREST_CONFIG:-}"

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $1"; }

die() {
    log_error "$1"
    exit 1
}

require_tools() {
    command -v "$BACKUP_BIN" >/dev/null 2>&1 || die "pgBackRest is unavailable: ${BACKUP_BIN}"
    command -v jq >/dev/null 2>&1 || die "jq is required to validate pgBackRest inventory"
    command -v sudo >/dev/null 2>&1 || die "sudo is required to run pgBackRest as ${BACKUP_USER}"
}

pgbackrest_args() {
    if [[ -n "$BACKUP_CONFIG" ]]; then
        printf '%s\n' "--config=${BACKUP_CONFIG}"
    fi
    printf '%s\n' "--stanza=${STANZA}"
}

run_pgbackrest() {
    local timeout_seconds="$1"
    shift
    mapfile -t common_args < <(pgbackrest_args)
    timeout --kill-after=30s "$timeout_seconds" \
        sudo -u "$BACKUP_USER" "$BACKUP_BIN" "${common_args[@]}" "$@"
}

inventory_json() {
    require_tools
    run_pgbackrest 15 info --output=json
}

validate_inventory() {
    local inventory="$1"
    jq -e --arg stanza "$STANZA" '
        .[0] as $cluster
        | type == "array" and length == 1
        and $cluster.name == $stanza
        and (($cluster.status.code == 0) or ($cluster.status.code == 2 and (($cluster.backup // []) | length == 0)))
        and (($cluster.repo // []) | length > 0)
        and all(($cluster.repo // [])[]; .status.code == $cluster.status.code)
    ' <<<"$inventory" >/dev/null \
        || die "pgBackRest inventory is unavailable or unhealthy for stanza ${STANZA}"
}

verify_inventory() {
    local inventory
    inventory="$(inventory_json)"
    validate_inventory "$inventory"
    jq -c --arg stanza "$STANZA" '
        .[0] as $cluster
        | {
            schema: "supacloud.backup-readiness.v1",
            provider: "pigsty.pgbackrest",
            stanza: $stanza,
            status: "ready",
            repository_count: (($cluster.repo // []) | length),
            completed_backup_count: ([($cluster.backup // [])[] | select(.error != true and .timestamp.stop > 0)] | length),
            latest_completed_backup: (
              [($cluster.backup // [])[] | select(.error != true and .timestamp.stop > 0)]
              | sort_by(.timestamp.stop)
              | last // null
            )
          }
    ' <<<"$inventory"
}

case $COMMAND in
    list)
        inventory="$(inventory_json)"
        validate_inventory "$inventory"
        printf '%s\n' "$inventory"
        ;;

    verify)
        verify_inventory
        ;;

    create)
        # Trigger immediate backup
        # Optional types: full, incr, diff (default incr)
        TYPE=${OPTIONS:-"incr"}
        [[ "$TYPE" =~ ^(full|incr|diff)$ ]] || die "Unsupported backup type: ${TYPE}"
        require_tools
        log_info "Starting $TYPE backup for stanza $STANZA..."
        run_pgbackrest 1800 "--type=${TYPE}" backup
        log_info "Backup command completed; validating inventory..."
        verify_inventory
        ;;

    restore)
        # Execute point-in-time recovery (PITR)
        # TARGET is target timestamp or LSN
        if [[ -z "$TARGET" ]]; then
            log_error "Restore target (timestamp/LSN) is required"
            exit 1
        fi
        
        [[ "${SUPACLOUD_PITR_ENABLED:-${PITR_ENABLED:-false}}" == "true" ]] \
            || die "Physical PITR is disabled"
        require_tools
        command -v pig >/dev/null 2>&1 || die "Pigsty pig command is unavailable"
        log_info "Initiating PITR restore to: $TARGET"
        # Use Pigsty's advanced orchestration tool pig pitr
        # It will automatically handle Patroni pause, data recovery, startup etc.
        timeout --kill-after=30s 1800 sudo -u "$BACKUP_USER" pig pitr \
            -s "$STANZA" -t "$TARGET" -y
        log_info "PITR restore completed"
        ;;

    *)
        echo "Usage: $0 {list|verify|create|restore} [stanza/target] [options]"
        exit 1
        ;;
esac

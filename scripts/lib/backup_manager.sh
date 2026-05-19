#!/bin/bash

# backup_manager.sh
# Manage project database backups (based on Pigsty 4.x / pgBackRest)

set -e

COMMAND=$1
TARGET=$2  # For pgBackRest, usually stanza name; for PITR, target time
OPTIONS=$3

# Default Stanza name (usually configured by Pigsty, default is db-main)
STANZA=${TARGET:-"db-main"}

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $1"; }

case $COMMAND in
    list)
        # Get backup list (JSON format)
        # Result usually contains backup ID, type, time, size etc.
        if ! command -v pgbackrest &> /dev/null; then
            echo "[]"
            exit 0
        fi
        timeout 15 sudo -u postgres pgbackrest --stanza="$STANZA" info --output=json 2>/dev/null || echo "[]"
        ;;

    create)
        # Trigger immediate backup
        # Optional types: full, incr, diff (default incr)
        TYPE=${OPTIONS:-"incr"}
        log_info "Starting $TYPE backup for stanza $STANZA..."
        sudo -u postgres pgbackrest --stanza="$STANZA" --type="$TYPE" backup
        log_info "Backup completed successfully"
        ;;

    restore)
        # Execute point-in-time recovery (PITR)
        # TARGET is target timestamp or LSN
        if [[ -z "$TARGET" ]]; then
            log_error "Restore target (timestamp/LSN) is required"
            exit 1
        fi
        
        log_info "Initiating PITR restore to: $TARGET"
        # Use Pigsty's advanced orchestration tool pig pitr
        # It will automatically handle Patroni pause, data recovery, startup etc.
        sudo -u postgres pig pitr "$TARGET"
        log_info "Restore process initiated"
        ;;

    *)
        echo "Usage: $0 {list|create|restore} [stanza/target] [options]"
        exit 1
        ;;
esac

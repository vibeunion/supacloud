#!/bin/bash

# storage_manager.sh
# Manage JuiceFS storage and S3 migration

set -e

COMMAND=$1
TARGET=$2

MOUNT_POINT="/mnt/juicefs"
# Default points to local Supabase-specific JuiceFS metadata database
# If password was modified in install.sh, need to align here as well
META_URL="postgres://postgres:${POSTGRES_PASSWORD:-postgres}@localhost:5432/postgres?sslmode=disable"

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $1"; }

case $COMMAND in
    status)
        # Check maintenance status and space usage
        if mountpoint -q "$MOUNT_POINT"; then
            df -h "$MOUNT_POINT" | tail -n 1 | awk '{print "{\"status\":\"mounted\",\"size\":\""$2"\",\"used\":\""$3"\",\"avail\":\""$4"\",\"use_percent\":\""$5"\"}"}'
        else
            echo "{\"status\":\"unmounted\"}"
        fi
        ;;

    migrate_to_s3)
        # Migrate to S3
        # TARGET: S3_URL (e.g., s3://mybucket)
        # Credentials are read from stdin so they never appear in process arguments.
        OPTIONS=$(cat)
        S3_URL=$TARGET
        ACCESS_KEY=$(echo "$OPTIONS" | jq -r .access_key)
        SECRET_KEY=$(echo "$OPTIONS" | jq -r .secret_key)
        ENDPOINT=$(echo "$OPTIONS" | jq -r .endpoint)

        if [ -z "$S3_URL" ] || [ -z "$ACCESS_KEY" ]; then
            log_error "Missing migration parameters"
            exit 1
        fi

        log_info "Starting migration from PG-LO to $S3_URL..."
        
        # Use juicefs sync to perform data migration
        # --force-update ensures full overwrite validation
        export ACCESS_KEY="$ACCESS_KEY"
        export SECRET_KEY="$SECRET_KEY"
        
        # If endpoint is provided, specify it in sync
        if [ -n "$ENDPOINT" ] && [ "$ENDPOINT" != "null" ]; then
            juicefs sync --force-update --endpoint "$ENDPOINT" "jfs://${META_URL}" "${S3_URL}"
        else
            juicefs sync --force-update "jfs://${META_URL}" "${S3_URL}"
        fi
        
        log_info "Data sync completed. Next: Dump metadata..."
        
        # Export metadata for later load
        juicefs dump "${META_URL}" metadata_migration_backup.json
        
        log_info "Migration prepared successfully"
        ;;

    *)
        echo "Usage: $0 {status|migrate_to_s3} [target]"
        exit 1
        ;;
esac

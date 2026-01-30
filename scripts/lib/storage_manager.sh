#!/bin/bash

# storage_manager.sh
# 管理 JuiceFS 存储与 S3 迁移

set -e

COMMAND=$1
TARGET=$2
OPTIONS=$3

MOUNT_POINT="/mnt/juicefs"
META_URL="postgres://postgres:postgres@localhost:5432/juicefs?sslmode=disable"

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $1"; }

case $COMMAND in
    status)
        # 检查维护状态与空间使用
        if mountpoint -q "$MOUNT_POINT"; then
            df -h "$MOUNT_POINT" | tail -n 1 | awk '{print "{\"status\":\"mounted\",\"size\":\""$2"\",\"used\":\""$3"\",\"avail\":\""$4"\",\"use_percent\":\""$5"\"}"}'
        else
            echo "{\"status\":\"unmounted\"}"
        fi
        ;;

    migrate_to_s3)
        # 迁移至 S3
        # TARGET: S3_URL (e.g., s3://mybucket)
        # OPTIONS: JSON string with access_key and secret_key
        S3_URL=$TARGET
        ACCESS_KEY=$(echo "$OPTIONS" | jq -r .access_key)
        SECRET_KEY=$(echo "$OPTIONS" | jq -r .secret_key)
        ENDPOINT=$(echo "$OPTIONS" | jq -r .endpoint)

        if [ -z "$S3_URL" ] || [ -z "$ACCESS_KEY" ]; then
            log_error "Missing migration parameters"
            exit 1
        fi

        log_info "Starting migration from PG-LO to $S3_URL..."
        
        # 使用 juicefs sync 执行数据迁移
        # --force-update 确保全量覆盖校验
        export ACCESS_KEY="$ACCESS_KEY"
        export SECRET_KEY="$SECRET_KEY"
        
        juicefs sync --force-update "jfs://${META_URL}" "${S3_URL}"
        
        log_info "Data sync completed. Next: Dump metadata..."
        
        # 导出元数据供以后 load
        juicefs dump "${META_URL}" metadata_migration_backup.json
        
        log_info "Migration prepared successfully"
        ;;

    *)
        echo "Usage: $0 {status|migrate_to_s3} [target] [options]"
        exit 1
        ;;
esac

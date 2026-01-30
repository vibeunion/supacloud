#!/bin/bash

# backup_manager.sh
# 管理项目数据库备份

set -e

COMMAND=$1
PROJECT_REF=$2
BACKUP_ID=$3

BACKUP_DIR="/data/backups/${PROJECT_REF}"
DB_NAME="supa_${PROJECT_REF}"

case $COMMAND in
    list)
        if [ ! -d "$BACKUP_DIR" ]; then
            echo "[]"
            exit 0
        fi
        cd "$BACKUP_DIR"
        # 扫描备份文件并返回结构化数据
        ls -lh --time-style=long-iso *.sql *.dump 2>/dev/null | awk '{
            print "{\"id\":\""$8"\",\"size\":\""$5"\",\"created_at\":\""$6"T"$7"Z\"}"
        }' | jq -s .
        ;;

    restore)
        FILE="$BACKUP_DIR/${BACKUP_ID}"
        if [ ! -f "$FILE" ]; then
            echo "Error: Backup file not found" >&2
            exit 1
        fi
        
        echo "Restoring database ${DB_NAME} from ${BACKUP_ID}..."
        # 简单实现：使用 psql 执行 sql 备份
        # 如果是二进制 dump，则需使用 pg_restore
        if [[ "$FILE" == *.dump ]]; then
            pg_restore -d "$DB_NAME" "$FILE"
        else
            psql -d "$DB_NAME" -f "$FILE"
        fi
        echo "Restore successful"
        ;;

    *)
        echo "Usage: $0 {list|restore} <project_ref> [backup_id]"
        exit 1
        ;;
esac

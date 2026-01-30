#!/bin/bash

# backup_manager.sh
# 管理项目数据库备份 (基于 Pigsty 4.x / pgBackRest)

set -e

COMMAND=$1
TARGET=$2  # 对于 pgBackRest，通常是 stanza 名；对于 PITR，是目标时间
OPTIONS=$3

# 默认 Stanza 名 (通常由 Pigsty 配置，默认为 db-main)
STANZA=${TARGET:-"db-main"}

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $1"; }

case $COMMAND in
    list)
        # 获取备份列表 (JSON 格式)
        # 结果通常包含备份 ID、类型、时间、大小等信息
        if ! command -v pgbackrest &> /dev/null; then
            echo "[]"
            exit 0
        fi
        sudo -u postgres pgbackrest --stanza="$STANZA" info --output=json
        ;;

    create)
        # 触发即时备份
        # 可选类型: full, incr, diff (默认 incr)
        TYPE=${OPTIONS:-"incr"}
        log_info "Starting $TYPE backup for stanza $STANZA..."
        sudo -u postgres pgbackrest --stanza="$STANZA" --type="$TYPE" backup
        log_info "Backup completed successfully"
        ;;

    restore)
        # 执行点对点恢复 (PITR)
        # TARGET 为目标时间戳或 LSN
        if [[ -z "$TARGET" ]]; then
            log_error "Restore target (timestamp/LSN) is required"
            exit 1
        fi
        
        log_info "Initiating PITR restore to: $TARGET"
        # 使用 Pigsty 的高级编排工具 pig pitr
        # 它会自动处理 Patroni 暂停、数据恢复、启动等流程
        sudo -u postgres pig pitr "$TARGET"
        log_info "Restore process initiated"
        ;;

    *)
        echo "Usage: $0 {list|create|restore} [stanza/target] [options]"
        exit 1
        ;;
esac

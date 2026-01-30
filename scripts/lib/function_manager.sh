#!/bin/bash

# function_manager.sh
# 管理 Supacloud 项目的边缘函数

set -e

COMMAND=$1
PROJECT_REF=$2
SLUG=$3
CODE=$4

DATA_DIR="/data/projects/${PROJECT_REF}/functions"

case $COMMAND in
    list)
        if [ ! -d "$DATA_DIR" ]; then
            echo "[]"
            exit 0
        fi
        # 列出所有子目录并返回 JSON 数组
        cd "$DATA_DIR"
        FUNCTIONS=$(ls -d */ 2>/dev/null | sed 's/\///g' | jq -R . | jq -s .)
        echo "${FUNCTIONS:-[]}"
        ;;

    read)
        FILE="$DATA_DIR/${SLUG}/index.ts"
        if [ ! -f "$FILE" ]; then
            echo "Error: Function not found" >&2
            exit 1
        fi
        cat "$FILE"
        ;;

    deploy)
        FUNC_DIR="$DATA_DIR/${SLUG}"
        mkdir -p "$FUNC_DIR"
        echo "$CODE" > "$FUNC_DIR/index.ts"
        # 此处可以增加重启服务的逻辑
        echo "Deployed successfully"
        ;;

    delete)
        FUNC_DIR="$DATA_DIR/${SLUG}"
        if [ -d "$FUNC_DIR" ]; then
            rm -rf "$FUNC_DIR"
            echo "Deleted successfully"
        else
            echo "Error: Function not found" >&2
            exit 1
        fi
        ;;

    *)
        echo "Usage: $0 {list|read|deploy|delete} <project_ref> [slug] [code]"
        exit 1
        ;;
esac

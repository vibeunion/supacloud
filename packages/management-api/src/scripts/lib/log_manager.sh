#!/bin/bash
# SupaCloud - Lightweight Log Manager
# Usage: log_manager.sh <ref> <type> [limit]
#   <ref> - Project reference
#   <type> - all, auth, api, database
#   [limit] - Number of lines to return (default 50)

set -euo pipefail

PROJECT_REF="${1:-}"
LOG_TYPE="${2:-all}"
LIMIT="${3:-50}"

if [ -z "$PROJECT_REF" ]; then
    echo "[]"
    exit 0
fi

auth_cmd="journalctl -u supacloud-gotrue@${PROJECT_REF} -o json -n ${LIMIT} --no-pager"
api_cmd="journalctl -u supacloud-pgrst@${PROJECT_REF} -o json -n ${LIMIT} --no-pager"
# For database, we might need a different approach or just tail a file if configured.

raw_logs=""

get_logs() {
    local cmd="$1"
    local source_name="$2"
    # Execute and add source annotation natively using jq
    eval "$cmd" 2>/dev/null | jq -c ". + {SYS_SOURCE: \"$source_name\"}" || true
}

case "$LOG_TYPE" in
    auth)
        raw_logs=$(get_logs "$auth_cmd" "auth")
        ;;
    api)
        raw_logs=$(get_logs "$api_cmd" "api")
        ;;
    all)
        logs_auth=$(get_logs "$auth_cmd" "auth")
        logs_api=$(get_logs "$api_cmd" "api")
        raw_logs=$(echo -e "${logs_auth}\n${logs_api}")
        ;;
    database)
        # Placeholder for DB logs
        raw_logs=""
        ;;
    *)
        raw_logs=""
        ;;
esac

if [ -z "$raw_logs" ]; then
    echo "[]"
    exit 0
fi

# We use jq to parse systemd json format into an array of lines, sorting them by timestamp descending
echo "$raw_logs" | jq -s 'sort_by(.__REALTIME_TIMESTAMP | tonumber) | reverse | .[0:'$LIMIT']'

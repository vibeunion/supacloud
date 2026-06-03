#!/bin/bash
# SupaCloud - PostgREST tenant watchdog
# Detects tenant-local PostgREST HTTP 503s and schema-cache failures such as PGRST002.

set -euo pipefail

STATE_ROOT="${SUPACLOUD_WATCHDOG_STATE_DIR:-/var/lib/supacloud/postgrest-watchdog}"
TENANT_DIR="${SUPACLOUD_TENANT_CONFIG_DIR:-/etc/supabase/tenants}"
JOURNAL_WINDOW="${SUPACLOUD_WATCHDOG_JOURNAL_WINDOW:-5 minutes ago}"
HOSTNAME_VALUE="$(hostname)"

mkdir -p "$STATE_ROOT"

if [[ -f /etc/supabase/management-api.env ]]; then
    # shellcheck disable=SC1091
    source /etc/supabase/management-api.env
fi

ALERT_WEBHOOK_URL="${SUPACLOUD_ALERT_WEBHOOK_URL:-}"

json_escape() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//$'\n'/\\n}"
    value="${value//$'\r'/\\r}"
    value="${value//$'\t'/\\t}"
    printf '"%s"' "$value"
}

send_alert() {
    local severity="$1"
    local tenant="$2"
    local message="$3"
    local payload
    payload=$(cat <<EOF
{"severity":"${severity}","tenant":"${tenant}","host":"${HOSTNAME_VALUE}","message":$(json_escape "$message")}
EOF
)

    logger -t supacloud-postgrest-watchdog "[$severity] ${tenant}: ${message}"

    if [[ -n "$ALERT_WEBHOOK_URL" ]]; then
        curl -fsS -X POST \
            -H 'Content-Type: application/json' \
            -d "$payload" \
            "$ALERT_WEBHOOK_URL" >/dev/null || logger -t supacloud-postgrest-watchdog "[warn] webhook delivery failed for ${tenant}"
    fi
}

set_state() {
    local tenant="$1"
    local state="$2"
    printf '%s' "$state" > "${STATE_ROOT}/${tenant}.state"
}

get_state() {
    local tenant="$1"
    local state_file="${STATE_ROOT}/${tenant}.state"
    if [[ -f "$state_file" ]]; then
        cat "$state_file"
    fi
}

check_tenant() {
    local conf="$1"
    local tenant="${conf##*/}"
    tenant="${tenant%.conf}"

    local port
    port=$(sed -n 's/^server-port = \([0-9][0-9]*\)$/\1/p' "$conf" | head -n 1)
    if [[ -z "$port" ]]; then
        echo "missing-port|Tenant config ${conf} is missing server-port"
        return 0
    fi

    local http_code
    http_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${port}/" || true)
    if [[ "$http_code" != "200" ]]; then
        echo "http-${http_code}|Local PostgREST probe on 127.0.0.1:${port} returned HTTP ${http_code}"
        return 0
    fi

    local journal_match
    journal_match=$(journalctl -u "supacloud-pgrst@${tenant}" --since "$JOURNAL_WINDOW" --no-pager 2>/dev/null \
        | grep -E 'PGRST002|Failed to load the schema cache|schema "pgmq_public" does not exist' \
        | tail -n 1 || true)
    if [[ -n "$journal_match" ]]; then
        echo "journal-error|${journal_match}"
        return 0
    fi

    echo "ok|healthy"
}

main() {
    local any_issue=0
    shopt -s nullglob
    local confs=("$TENANT_DIR"/*.conf)
    shopt -u nullglob

    if [[ "${#confs[@]}" -eq 0 ]]; then
        logger -t supacloud-postgrest-watchdog "[info] no tenant config files found under ${TENANT_DIR}"
        exit 0
    fi

    for conf in "${confs[@]}"; do
        [[ "$conf" == *.bak* ]] && continue

        local tenant="${conf##*/}"
        tenant="${tenant%.conf}"

        local result issue detail fingerprint previous
        result=$(check_tenant "$conf")
        issue="${result%%|*}"
        detail="${result#*|}"
        previous="$(get_state "$tenant")"

        if [[ "$issue" == "ok" ]]; then
            if [[ -n "$previous" && "$previous" != ok ]]; then
                send_alert "recovered" "$tenant" "PostgREST recovered: ${detail}"
            fi
            set_state "$tenant" "ok"
            continue
        fi

        any_issue=1
        fingerprint="${issue}|${detail}"
        if [[ "$previous" != "$fingerprint" ]]; then
            send_alert "critical" "$tenant" "$detail"
            set_state "$tenant" "$fingerprint"
        fi
    done

    if [[ "$any_issue" -ne 0 ]]; then
        exit 1
    fi
}

main "$@"

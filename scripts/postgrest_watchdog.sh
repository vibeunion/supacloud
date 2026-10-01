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
    local tenant="$1"
    local conf="$2"

    if [[ -z "$conf" ]]; then
        echo "missing-config|Tenant ${tenant} has no resolvable PostgREST configuration"
        return 0
    fi

    local port
    port=$(sed -n 's/^server-port = \([0-9][0-9]*\)$/\1/p' "$conf" | head -n 1)
    if [[ -z "$port" ]]; then
        echo "missing-port|Tenant config ${conf} is missing server-port"
        return 0
    fi

    local http_code
    http_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${port}/" || true)
    # A reachable PostgREST answers 401 (or 404) to an unauthenticated root probe;
    # that is healthy. Only a failed connection or a 5xx — for example the 503
    # raised when the schema cache cannot load — is an incident.
    if [[ ! "$http_code" =~ ^[1-4][0-9]{2}$ ]]; then
        echo "http-${http_code}|Local PostgREST probe on 127.0.0.1:${port} returned HTTP ${http_code:-no-response}"
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

resolve_tenant_configs() {
    # Mirror the PostgREST launcher: a tenant on the generation layout is
    # described by <ref>_postgrest.current -> <ref>_postgrest.d/<sha>.conf, and a
    # legacy tenant by <ref>.conf. Emit "<ref>\t<conf-path>" for each active
    # tenant so the watchdog probes the configuration the runtime actually loads.
    local pointer ref target legacy pointer_refs=""
    shopt -s nullglob
    local pointers=("$TENANT_DIR"/*_postgrest.current)
    local legacies=("$TENANT_DIR"/*.conf)
    shopt -u nullglob

    for pointer in ${pointers[@]+"${pointers[@]}"}; do
        [[ "$pointer" == *.bak* ]] && continue
        ref="${pointer##*/}"
        ref="${ref%_postgrest.current}"
        [[ -n "$ref" ]] || continue
        target=""
        if IFS= read -r target < "$pointer" \
            && [[ "$target" =~ ^${ref}_postgrest\.d/[a-f0-9]{64}\.conf$ ]] \
            && [[ -f "$TENANT_DIR/$target" ]]; then
            printf '%s\t%s\n' "$ref" "$TENANT_DIR/$target"
        else
            printf '%s\t%s\n' "$ref" ""
        fi
        pointer_refs="${pointer_refs} ${ref}"
    done

    for legacy in ${legacies[@]+"${legacies[@]}"}; do
        [[ "$legacy" == *.bak* ]] && continue
        ref="${legacy##*/}"
        ref="${ref%.conf}"
        [[ -n "$ref" ]] || continue
        case "${pointer_refs} " in
            *" ${ref} "*) continue ;;
        esac
        printf '%s\t%s\n' "$ref" "$legacy"
    done
}

main() {
    local any_issue=0
    local configs
    configs="$(resolve_tenant_configs)"

    if [[ -z "$configs" ]]; then
        logger -t supacloud-postgrest-watchdog "[info] no tenant config files found under ${TENANT_DIR}"
        exit 0
    fi

    local tenant conf result issue detail fingerprint previous
    while IFS=$'\t' read -r tenant conf; do
        [[ -n "$tenant" ]] || continue

        result=$(check_tenant "$tenant" "$conf")
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
    done <<< "$configs"

    if [[ "$any_issue" -ne 0 ]]; then
        exit 1
    fi
}

main "$@"

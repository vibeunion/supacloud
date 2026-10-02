#!/bin/bash
# SupaCloud - PostgREST tenant watchdog
# Detects tenant-local PostgREST HTTP 503s and schema-cache failures such as PGRST002.

set -euo pipefail
export LC_ALL=C

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
ALERT_WEBHOOK_TIMEOUT="${SUPACLOUD_WATCHDOG_WEBHOOK_TIMEOUT:-5}"
if [[ ! "$ALERT_WEBHOOK_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
    ALERT_WEBHOOK_TIMEOUT=5
fi

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
        # Bound delivery so a stalled endpoint cannot hold the watchdog open and
        # delay the remaining tenants. Disable curlrc first so ambient retry
        # settings cannot restart the per-transfer timeout or add extra URLs.
        curl -q -fsS \
            --connect-timeout "$ALERT_WEBHOOK_TIMEOUT" \
            --max-time "$ALERT_WEBHOOK_TIMEOUT" \
            -X POST \
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

path_identity_nofollow() {
    # GNU and BSD `stat` do not follow a final symlink by default (verified on
    # both), so this reports the entry's own dev:inode as required.
    local target="$1"
    stat -c '%d:%i' -- "$target" 2>/dev/null \
        || stat -f '%d:%i' -- "$target" 2>/dev/null
}

path_field() {
    local target="$1" gnu_format="$2" bsd_format="$3"
    stat -c "$gnu_format" -- "$target" 2>/dev/null \
        || stat -f "$bsd_format" -- "$target" 2>/dev/null
}

descriptor_field() {
    # Read a field from the open descriptor rather than the path, so a path swap
    # cannot change the metadata we validate.
    local fd="$1" gnu_format="$2" bsd_format="$3" fdpath=""
    if [[ -e "/proc/self/fd/$fd" ]]; then
        fdpath="/proc/self/fd/$fd"
    elif [[ -e "/dev/fd/$fd" ]]; then
        fdpath="/dev/fd/$fd"
    else
        return 1
    fi
    stat -L -c "$gnu_format" -- "$fdpath" 2>/dev/null \
        || stat -L -f "$bsd_format" -- "$fdpath" 2>/dev/null
}

read_trusted_config_port() {
    # Resolve the port once, from a single opened descriptor, so the probe never
    # reopens the path. Validate descriptor-based identity, link count, owner and
    # mode; a path swapped between checks cannot redirect the read. A portable
    # shell cannot open with O_NOFOLLOW/O_NONBLOCK, so the root-owned, unwritable
    # configuration directory remains the boundary for the pre-open window.
    local conf="$1" ref="$2"
    local fd_id path_id mode owner links tenant_uid content port=""

    [[ -n "$conf" && -f "$conf" && ! -L "$conf" && -r "$conf" ]] || return 0
    exec 9< "$conf" 2>/dev/null || return 0
    fd_id="$(descriptor_field 9 '%d:%i' '%d:%i')" || { exec 9<&-; return 0; }
    path_id="$(path_identity_nofollow "$conf")" || { exec 9<&-; return 0; }
    if [[ -e /proc/self/fd/9 ]]; then
        # Linux: /proc/self/fd follows to the real inode including its device.
        [[ -n "$fd_id" && "$fd_id" == "$path_id" ]] || { exec 9<&-; return 0; }
    else
        # macOS /dev/fd reports the devfs device, so compare the inode only.
        [[ -n "$fd_id" && "${fd_id#*:}" == "${path_id#*:}" ]] || { exec 9<&-; return 0; }
    fi
    mode="$(descriptor_field 9 '%a' '%Lp')" || { exec 9<&-; return 0; }
    owner="$(descriptor_field 9 '%u' '%u')" || { exec 9<&-; return 0; }
    links="$(descriptor_field 9 '%h' '%l')" || { exec 9<&-; return 0; }
    if [[ ! -e /proc/self/fd/9 ]]; then
        # macOS /dev/fd reports the correct owner and link count but a fixed
        # devfs mode, so take the mode from the path and re-confirm the path
        # still resolves to the opened inode afterwards (a swap is rejected).
        mode="$(path_field "$conf" '%a' '%Lp')" || { exec 9<&-; return 0; }
        [[ "$(path_identity_nofollow "$conf")" == "$path_id" ]] || { exec 9<&-; return 0; }
    fi
    content="$(head -c 65536 <&9 || true)"
    exec 9<&-

    [[ -n "$mode" && -n "$owner" && -n "$links" ]] || return 0
    if [[ "$links" != "1" ]] || (( (8#$mode & 8#022) != 0 )); then
        printf '!untrusted'
        return 0
    fi
    # Mirror the launcher: the file is trusted only for root, the current
    # effective user, or the tenant's own runtime account.
    tenant_uid="$(id -u "supacloud-$ref" 2>/dev/null || true)"
    if [[ "$owner" != "0" && "$owner" != "$EUID" && ( -z "$tenant_uid" || "$owner" != "$tenant_uid" ) ]]; then
        printf '!untrusted'
        return 0
    fi
    port="$(printf '%s\n' "$content" | sed -n '/^server-port = [0-9][0-9]*$/ { s/^server-port = //; p; q; }')"
    printf '%s' "$port"
}

check_tenant() {
    local tenant="$1"
    local conf="$2"
    local port="$3"

    if [[ -z "$conf" ]]; then
        echo "missing-config|Tenant ${tenant} has no resolvable PostgREST configuration"
        return 0
    fi
    if [[ "$port" == '!untrusted' ]]; then
        echo "untrusted-config|Tenant config ${conf} failed the trusted-file checks"
        return 0
    fi
    if [[ -z "$port" ]]; then
        echo "missing-port|Tenant config ${conf} is missing server-port"
        return 0
    fi

    local http_code curl_status=0
    # A final 2xx-4xx response proves reachability, not authorization. Do not
    # ignore transfer failures: curl may emit a status before timing out.
    # Keep this tenant-local probe independent of proxy and curlrc settings.
    http_code=$(curl -q --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${port}/") || curl_status=$?
    if [[ "$curl_status" -ne 0 || ! "$http_code" =~ ^[2-4][0-9]{2}$ ]]; then
        echo "http-${http_code}|Local PostgREST probe on 127.0.0.1:${port} returned HTTP ${http_code:-no-response} (curl exit ${curl_status})"
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
    # Follow launcher selection: an existing generation pointer is authoritative,
    # even when malformed. Never silently fall back to a stale legacy config.
    local pointer ref target legacy pointer_bytes generation
    shopt -s nullglob
    local pointers=("$TENANT_DIR"/*_postgrest.current)
    local legacies=("$TENANT_DIR"/*.conf)
    shopt -u nullglob

    for pointer in ${pointers[@]+"${pointers[@]}"}; do
        ref="${pointer##*/}"
        ref="${ref%_postgrest.current}"
        [[ "$ref" =~ ^[a-z0-9-]{1,64}$ ]] || continue
        target=""
        generation="$TENANT_DIR/${ref}_postgrest.d"
        # Bound reads and reject special files before opening them (a FIFO can
        # otherwise hang every tenant's watchdog). Match the launcher's single
        # newline-terminated target and reject symlinks in the selected paths.
        if [[ -f "$pointer" && ! -L "$pointer" && -r "$pointer" ]] \
            && pointer_bytes=$(wc -c < "$pointer") \
            && [[ "$pointer_bytes" -le 160 ]] \
            && IFS= read -r target < "$pointer" \
            && [[ "$target" =~ ^${ref}_postgrest\.d/[a-f0-9]{64}\.conf$ ]] \
            && [[ "$pointer_bytes" -eq $((${#target} + 1)) ]] \
            && [[ -d "$generation" && ! -L "$generation" ]] \
            && [[ -f "$TENANT_DIR/$target" && ! -L "$TENANT_DIR/$target" && -r "$TENANT_DIR/$target" ]]; then
            printf '%s\t%s\t%s\n' "$ref" "$TENANT_DIR/$target" "$(read_trusted_config_port "$TENANT_DIR/$target" "$ref")"
        else
            printf '%s\t%s\t%s\n' "$ref" "" ""
        fi
    done

    for legacy in ${legacies[@]+"${legacies[@]}"}; do
        ref="${legacy##*/}"
        ref="${ref%.conf}"
        [[ "$ref" =~ ^[a-z0-9-]{1,64}$ ]] || continue
        pointer="$TENANT_DIR/${ref}_postgrest.current"
        [[ -e "$pointer" || -L "$pointer" ]] && continue
        printf '%s\t%s\t%s\n' "$ref" "$legacy" "$(read_trusted_config_port "$legacy" "$ref")"
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

    local tenant conf port result issue detail fingerprint previous
    while IFS=$'\t' read -r tenant conf port; do
        [[ -n "$tenant" ]] || continue

        result=$(check_tenant "$tenant" "$conf" "$port")
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

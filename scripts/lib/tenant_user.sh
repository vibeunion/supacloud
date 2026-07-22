#!/usr/bin/env bash

set -euo pipefail
umask 077

ref="${1:-}"
if [[ ! "$ref" =~ ^[a-z0-9-]{1,20}$ ]]; then
    echo "ERROR: Invalid tenant project ref" >&2
    exit 2
fi

runtime_user="supacloud-${ref}"

resolve_nologin_shell() {
    local resolved
    resolved=$(command -v nologin 2>/dev/null || true)
    if [[ -n "$resolved" && -x "$resolved" ]]; then
        printf '%s' "$resolved"
        return 0
    fi
    for resolved in /usr/sbin/nologin /sbin/nologin; do
        if [[ -x "$resolved" ]]; then
            printf '%s' "$resolved"
            return 0
        fi
    done
    return 1
}

system_uid_max() {
    local configured
    configured=$(awk '$1 == "SYS_UID_MAX" { value=$2 } END { print value }' /etc/login.defs 2>/dev/null || true)
    if [[ "$configured" =~ ^[0-9]+$ ]]; then
        printf '%s' "$configured"
    else
        printf '999'
    fi
}

validate_runtime_user() {
    local expected_shell="$1"
    local passwd_entry group_entry name uid gid home shell group_name group_gid uid_max
    passwd_entry=$(getent passwd "$runtime_user" 2>/dev/null) || {
        echo "ERROR: Tenant runtime account ${runtime_user} is missing" >&2
        return 1
    }
    IFS=: read -r name _ uid gid _ home shell <<< "$passwd_entry"
    uid_max=$(system_uid_max)
    if [[ "$name" != "$runtime_user" || ! "$uid" =~ ^[0-9]+$ || "$uid" -eq 0 || "$uid" -gt "$uid_max" \
        || "$home" != "/nonexistent" ]]; then
        echo "ERROR: Tenant runtime account ${runtime_user} violates the system-user contract" >&2
        return 1
    fi
    case "$shell" in
        "$expected_shell"|/usr/sbin/nologin|/sbin/nologin) ;;
        *)
            echo "ERROR: Tenant runtime account ${runtime_user} violates the system-user contract" >&2
            return 1
            ;;
    esac

    group_entry=$(getent group "$runtime_user" 2>/dev/null) || {
        echo "ERROR: Tenant runtime group ${runtime_user} is missing" >&2
        return 1
    }
    IFS=: read -r group_name _ group_gid _ <<< "$group_entry"
    if [[ "$group_name" != "$runtime_user" || ! "$group_gid" =~ ^[0-9]+$ || "$group_gid" -eq 0 || "$group_gid" != "$gid" ]]; then
        echo "ERROR: Tenant runtime account ${runtime_user} has an unexpected primary group" >&2
        return 1
    fi
}

nologin_shell=$(resolve_nologin_shell) || {
    echo "ERROR: nologin shell not found" >&2
    exit 1
}

if getent passwd "$runtime_user" >/dev/null 2>&1; then
    validate_runtime_user "$nologin_shell"
    exit 0
fi

useradd \
    --system \
    --user-group \
    --no-create-home \
    --home-dir /nonexistent \
    --shell "$nologin_shell" \
    "$runtime_user"

validate_runtime_user "$nologin_shell"

#!/usr/bin/env bash

set -euo pipefail
umask 077

request_dir="/run/supacloud-unit-requests"
token="${1:-}"
if [[ ! "$token" =~ ^[a-f0-9-]{36}$ ]]; then
    echo "ERROR: Invalid systemd unit request token" >&2
    exit 2
fi

request_file="${request_dir}/${token}.request"
source_file="${request_dir}/${token}.unit"
[[ -f "$request_file" && ! -L "$request_file" ]] || {
    echo "ERROR: Systemd unit request is missing" >&2
    exit 1
}

read_request_value() {
    local key="$1" value count
    count=$(grep -Ec "^${key}=" "$request_file" || true)
    [[ "$count" == "1" ]] || return 1
    value=$(sed -n "s/^${key}=//p" "$request_file")
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1
    printf '%s' "$value"
}

operation=$(read_request_value operation) || { echo "ERROR: Invalid systemd unit operation" >&2; exit 1; }
unit_name=$(read_request_value unit_name) || { echo "ERROR: Invalid systemd unit name" >&2; exit 1; }
if [[ ! "$unit_name" =~ ^supacloud-(pgrst|gotrue)@\.service$ \
    && ! "$unit_name" =~ ^supacloud-frontend-[a-z0-9-]{1,64}\.service$ ]]; then
    echo "ERROR: Systemd unit is outside the SupaCloud allow-list" >&2
    exit 1
fi

validate_environment_file() {
    local value="$1"
    case "$unit_name" in
        supacloud-pgrst@.service)
            [[ "$value" =~ ^/etc/supabase/[A-Za-z0-9_-]{1,64}/%i\.env$ ]]
            ;;
        supacloud-gotrue@.service)
            [[ "$value" =~ ^/etc/supabase/[A-Za-z0-9_-]{1,64}/%i_gotrue\.env$ ]]
            ;;
        supacloud-frontend-*.service)
            [[ "$value" =~ ^/var/supacloud/frontends/([a-z0-9-]{1,20})/([a-f0-9]{8})/\.env$ ]] || return 1
            [[ "$unit_name" == "supacloud-frontend-${BASH_REMATCH[1]}-${BASH_REMATCH[2]}.service" ]]
            ;;
        *) return 1 ;;
    esac
}

validate_unit_content() {
    local section="" line key value user="" group="" seen_unit=0 seen_service=0 seen_install=0 seen_nnp=0 seen_env_file=0
    local unit_bytes environment_file_ok=0
    unit_bytes=$(wc -c < "$source_file")
    (( unit_bytes > 0 && unit_bytes <= 16384 )) || return 1
    cmp -s "$source_file" <(LC_ALL=C tr -d '\000-\011\013-\037\177' < "$source_file") || return 1
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" != *$'\r'* && "$line" != *\\ ]] || return 1
        [[ -z "$line" || "$line" =~ ^[[:space:]]*[#\;] ]] && continue
        if [[ "$line" =~ ^\[(Unit|Service|Install)\]$ ]]; then
            section="${BASH_REMATCH[1]}"
            case "$section" in
                Unit) (( seen_unit += 1 )) ;;
                Service) (( seen_service += 1 )) ;;
                Install) (( seen_install += 1 )) ;;
            esac
            [[ "$seen_unit" -le 1 && "$seen_service" -le 1 && "$seen_install" -le 1 ]] || return 1
            continue
        fi
        [[ "$line" =~ ^([A-Za-z][A-Za-z0-9]*)=(.*)$ ]] || return 1
        key="${BASH_REMATCH[1]}"
        value="${BASH_REMATCH[2]}"
        case "$section:$key" in
            Unit:After|Unit:Description|Unit:Documentation|Unit:Wants|\
            Service:CPUWeight|Service:Environment|Service:EnvironmentFile|Service:ExecReload|Service:ExecStart|\
            Service:Group|Service:LimitNOFILE|Service:MemoryMax|Service:NoNewPrivileges|Service:ProtectHome|\
            Service:ProtectSystem|Service:ReadOnlyPaths|Service:Restart|Service:RestartSec|Service:StartLimitBurst|\
            Service:StartLimitIntervalSec|Service:SyslogIdentifier|Service:Type|Service:User|Service:WorkingDirectory|\
            Install:WantedBy) ;;
            *) return 1 ;;
        esac
        if [[ "$key" == ExecStart || "$key" == ExecReload ]]; then
            [[ ! "$value" =~ ^[-+!:@\|] ]] || return 1
        fi
        if [[ "$key" == NoNewPrivileges ]]; then
            [[ "$value" == true && "$seen_nnp" == 0 ]] || return 1
            seen_nnp=1
        fi
        if [[ "$key" == EnvironmentFile ]]; then
            [[ "$seen_env_file" == 0 ]] && validate_environment_file "$value" || return 1
            seen_env_file=1
        fi
        if [[ "$key" == User ]]; then
            [[ -z "$user" && "$value" =~ ^supacloud-(%i|[a-z0-9-]{1,20})$ ]] || return 1
            user="$value"
        elif [[ "$key" == Group ]]; then
            [[ -z "$group" && "$value" =~ ^supacloud-(%i|[a-z0-9-]{1,20})$ ]] || return 1
            group="$value"
        fi
    done < "$source_file"
    if [[ "$unit_name" == "supacloud-pgrst@.service" || "$seen_env_file" == 1 ]]; then
        environment_file_ok=1
    fi
    [[ "$seen_unit" == 1 && "$seen_service" == 1 && "$seen_install" == 1 && "$seen_nnp" == 1 && "$environment_file_ok" == 1 \
        && -n "$user" && "$user" == "$group" ]] || return 1
    if [[ "$unit_name" == *'@'* && "$user" != "supacloud-%i" ]]; then
        return 1
    fi
    if [[ "$unit_name" == supacloud-frontend-* && "$unit_name" != supacloud-frontend-${user#supacloud-}-* ]]; then
        return 1
    fi
}

case "$operation" in
  install)
    [[ -f "$source_file" && ! -L "$source_file" ]] || {
        echo "ERROR: Systemd unit source is missing" >&2
        exit 1
    }
    validate_unit_content || {
        echo "ERROR: Systemd unit content is outside the managed policy" >&2
        exit 1
    }
    install -m 0644 "$source_file" "/etc/systemd/system/${unit_name}"
    ;;
  remove)
    rm -f "/etc/systemd/system/${unit_name}"
    ;;
  *)
    echo "ERROR: Unsupported systemd unit operation" >&2
    exit 1
    ;;
esac

systemctl daemon-reload
rm -f "$request_file" "$source_file"

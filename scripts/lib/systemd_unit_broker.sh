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

case "$operation" in
  install)
    [[ -f "$source_file" && ! -L "$source_file" ]] || {
        echo "ERROR: Systemd unit source is missing" >&2
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

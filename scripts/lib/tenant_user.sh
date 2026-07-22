#!/usr/bin/env bash

set -euo pipefail
umask 077

ref="${1:-}"
if [[ ! "$ref" =~ ^[a-z0-9-]{1,20}$ ]]; then
    echo "ERROR: Invalid tenant project ref" >&2
    exit 2
fi

runtime_user="supacloud-${ref}"
if id -u "$runtime_user" >/dev/null 2>&1; then
    exit 0
fi

nologin_shell=$(command -v nologin 2>/dev/null || true)
if [[ -z "$nologin_shell" || ! -x "$nologin_shell" ]]; then
    for candidate in /usr/sbin/nologin /sbin/nologin; do
        if [[ -x "$candidate" ]]; then
            nologin_shell="$candidate"
            break
        fi
    done
fi
if [[ -z "$nologin_shell" || ! -x "$nologin_shell" ]]; then
    echo "ERROR: nologin shell not found" >&2
    exit 1
fi

useradd \
    --system \
    --user-group \
    --no-create-home \
    --home-dir /nonexistent \
    --shell "$nologin_shell" \
    "$runtime_user"

id -u "$runtime_user" >/dev/null

#!/usr/bin/env bash

# Keep tenant execution independent of the installer's home and PATH.
install_application_bun_runtime() (
    set -euo pipefail
    local source_binary="$1" version="$2" root="${3:-/opt/supacloud/bun}"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    [[ -f "$source_binary" && -x "$source_binary" ]] || return 1
    [[ "$("$source_binary" --version)" == "$version" ]] || return 1
    local directory="$root/$version" temporary=""
    mkdir -p "$directory" || return 1
    [[ ! -L "$root" && ! -L "$directory" ]] || return 1
    chmod 0755 "$root" "$directory" || return 1
    if [[ -e "$directory/bun" || -L "$directory/bun" ]]; then
        [[ -f "$directory/bun" && ! -L "$directory/bun" ]] || return 1
        cmp -s "$source_binary" "$directory/bun" || {
            echo "ERROR: Existing application Bun version has different bytes" >&2
            return 1
        }
        chmod 0755 "$directory/bun" || return 1
        return 0
    fi
    temporary=$(mktemp "$directory/.bun-XXXXXX") || return 1
    trap '[[ -z "$temporary" ]] || rm -f "$temporary"' EXIT
    install -m 0755 "$source_binary" "$temporary" || return 1
    [[ "$("$temporary" --version)" == "$version" ]] || return 1
    mv "$temporary" "$directory/bun" || return 1
    temporary=""
)

#!/bin/sh
set -eu

managed_config="${SUPACLOUD_CADDY_CONFIG_PATH:-/etc/supacloud/caddy/config.json}"
initialized_marker="${SUPACLOUD_CADDY_INITIALIZED_MARKER:-/etc/supacloud/caddy/INITIALIZED}"
bootstrap_config="${SUPACLOUD_CADDY_BOOTSTRAP_CONFIG:-/etc/caddy/Caddyfile}"

if [ -L "$managed_config" ]; then
    printf '%s\n' "refusing symbolic-link managed Caddy config: $managed_config" >&2
    exit 1
fi

if [ -f "$managed_config" ]; then
    caddy validate --config "$managed_config"
    exec caddy run --config "$managed_config"
fi

if [ -e "$managed_config" ]; then
    printf '%s\n' "refusing non-regular managed Caddy config: $managed_config" >&2
    exit 1
fi

if [ -e "$initialized_marker" ] || [ -L "$initialized_marker" ]; then
    printf '%s\n' "refusing bootstrap after initialized Caddy config was lost" >&2
    exit 1
fi

caddy validate --config "$bootstrap_config" --adapter caddyfile
exec caddy run --config "$bootstrap_config" --adapter caddyfile

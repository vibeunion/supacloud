#!/bin/sh
set -eu

# ExecStartPost participates in systemd ordering, including on Podman 4.9 where
# Quadlet does not yet support Notify=healthy. A started process is not ready.
container_name="${1:?Container name is required}"
attempt=0
while [ "$attempt" -lt 120 ]; do
    if podman healthcheck run "$container_name" >/dev/null 2>&1; then
        exit 0
    fi
    attempt=$((attempt + 1))
    sleep 2
done
printf 'SupaCloud health check timed out: %s\n' "$container_name" >&2
exit 1

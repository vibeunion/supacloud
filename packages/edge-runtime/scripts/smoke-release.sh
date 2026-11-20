#!/usr/bin/env bash
set -euo pipefail

binary="${1:?usage: bash scripts/smoke-release.sh <compiled-binary>}"
port="${EDGE_SMOKE_PORT:-19090}"
version="$(bun -p 'require("./package.json").version')"

reported_version="$("$binary" --version)"
if [[ "$reported_version" != "supacloud-edge-runtime $version" ]]; then
  printf 'Expected Edge Runtime %s; binary reported %s\n' "$version" "$reported_version" >&2
  exit 1
fi

scratch="$(mktemp -d)"
pid=""
cleanup() {
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir "$scratch/functions"
EDGE_RUNTIME_HOST=127.0.0.1 PORT="$port" \
  EDGE_FUNCTIONS_DIR="$scratch/functions" EDGE_FUNCTIONS_BASE_DIR="$scratch/functions" \
  "$binary" >"$scratch/runtime.log" 2>&1 &
pid=$!

for ((attempt = 0; attempt < 40; attempt++)); do
  if ! kill -0 "$pid" 2>/dev/null; then
    break
  fi
  if health="$(curl -fsS --max-time 1 "http://127.0.0.1:$port/health" 2>/dev/null)"; then
    HEALTH="$health" EXPECTED_VERSION="$version" bun -e '
      const health = JSON.parse(process.env.HEALTH);
      if (health.status !== "ok" || health.packageVersion !== process.env.EXPECTED_VERSION) {
        throw new Error(`Unexpected Edge Runtime health response: ${process.env.HEALTH}`);
      }
    '
    printf '%s\n' "$health"
    exit 0
  fi
  sleep 0.5
done
cat "$scratch/runtime.log" >&2
exit 1

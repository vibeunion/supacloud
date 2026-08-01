#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CADDY_BINARY="${CADDY_BINARY:-$ROOT_DIR/packages/management-api/dist/supacloud-caddy-linux-amd64}"
BUN_BINARY="${BUN_BINARY:-bun}"
EDGE_PORT="${EDGE_PORT:-19090}"
CADDY_PORT="${CADDY_PORT:-18081}"
PROJECT_REF="caddyedgecompat"

if [[ ! -x "$CADDY_BINARY" ]]; then
  echo "Caddy smoke binary is not executable: $CADDY_BINARY" >&2
  exit 1
fi
if ! command -v "$BUN_BINARY" >/dev/null 2>&1; then
  echo "Bun is required for the Edge Runtime proxy smoke" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
functions_dir="$work_dir/functions"
tenants_dir="$work_dir/tenants"
cancel_started_path="$work_dir/slow-request-started"
edge_log="$work_dir/edge-runtime.log"
caddy_log="$work_dir/caddy.log"
edge_pid=""
caddy_pid=""
slow_client_pid=""

terminate_process() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  terminate_process "$slow_client_pid"
  terminate_process "$caddy_pid"
  terminate_process "$edge_pid"
  rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir -p "$functions_dir/$PROJECT_REF" "$tenants_dir"
cat >"$tenants_dir/$PROJECT_REF.env" <<EOF
CANCEL_STARTED_PATH=$cancel_started_path
EOF
cat >"$functions_dir/$PROJECT_REF/supauth.ts" <<'EOF'
export default {
  async fetch(request: Request) {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname.endsWith("/slow")) {
      await Bun.write(process.env.CANCEL_STARTED_PATH, "started");
      await new Promise((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    }
    const requestBody = await request.text();
    return new Response([
      requestUrl.pathname,
      request.headers.get("host"),
      request.headers.get("x-project-ref"),
      request.headers.get("x-forwarded-host"),
      request.headers.get("x-forwarded-proto"),
      requestBody,
    ].join("|"));
  },
};
EOF
cat >"$functions_dir/$PROJECT_REF/supauth.config.json" <<'EOF'
{"verify_jwt":false}
EOF

cat >"$work_dir/caddy.json" <<EOF
{
  "admin": { "disabled": true },
  "apps": {
    "http": {
      "servers": {
        "supacloud": {
          "listen": ["127.0.0.1:$CADDY_PORT"],
          "automatic_https": { "disable": true },
          "routes": [{
            "match": [{ "host": ["auth.edge.test"] }],
            "handle": [
              {
                "handler": "rewrite",
                "uri": "/functions/v1/supauth{http.request.uri.path}"
              },
              {
                "handler": "reverse_proxy",
                "upstreams": [{ "dial": "127.0.0.1:$EDGE_PORT" }],
                "headers": {
                  "request": {
                    "set": {
                      "Host": ["{http.request.host}"],
                      "X-Project-Ref": ["$PROJECT_REF"],
                      "x-project-ref": ["$PROJECT_REF"],
                      "X-Forwarded-Host": ["{http.request.host}"],
                      "X-Forwarded-Proto": ["{http.request.scheme}"]
                    }
                  }
                },
                "transport": {
                  "protocol": "http",
                  "read_timeout": "500s",
                  "write_timeout": "500s"
                },
                "flush_interval": -1
              }
            ]
          }]
        }
      }
    }
  }
}
EOF

EDGE_RUNTIME_HOST=127.0.0.1 \
EDGE_RUNTIME_PORT="$EDGE_PORT" \
EDGE_FUNCTIONS_DIR="$functions_dir" \
EDGE_FUNCTIONS_BASE_DIR="$functions_dir" \
EDGE_RUNTIME_MASTER_KEY=caddy-edge-smoke \
TENANTS_DIR="$tenants_dir" \
WORKER_POOL_SIZE=1 \
"$BUN_BINARY" "$ROOT_DIR/packages/edge-runtime/server.ts" >"$edge_log" 2>&1 &
edge_pid=$!

edge_ready=false
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$EDGE_PORT/health" >/dev/null 2>&1; then
    edge_ready=true
    break
  fi
  if ! kill -0 "$edge_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if [[ "$edge_ready" != true ]]; then
  cat "$edge_log" >&2
  exit 1
fi

XDG_DATA_HOME="$work_dir/caddy-data" \
XDG_CONFIG_HOME="$work_dir/caddy-config" \
"$CADDY_BINARY" run --config "$work_dir/caddy.json" >"$caddy_log" 2>&1 &
caddy_pid=$!

caddy_ready=false
for _ in $(seq 1 40); do
  if curl -fsS -H "Host: auth.edge.test" \
    "http://127.0.0.1:$CADDY_PORT/api/v1/health" >/dev/null 2>&1; then
    caddy_ready=true
    break
  fi
  if ! kill -0 "$caddy_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if [[ "$caddy_ready" != true ]]; then
  cat "$caddy_log" >&2
  cat "$edge_log" >&2
  exit 1
fi

curl -fsS --max-time 10 -H "Host: auth.edge.test" \
  "http://127.0.0.1:$CADDY_PORT/api/v1/slow" >/dev/null 2>&1 &
slow_client_pid=$!

slow_started=false
for _ in $(seq 1 100); do
  if [[ -s "$cancel_started_path" ]]; then
    slow_started=true
    break
  fi
  if ! kill -0 "$slow_client_pid" 2>/dev/null; then
    break
  fi
  sleep 0.05
done
if [[ "$slow_started" != true ]]; then
  echo "Client disconnected before the slow Edge Function started" >&2
  cat "$caddy_log" >&2
  cat "$edge_log" >&2
  exit 1
fi
terminate_process "$slow_client_pid"
slow_client_pid=""

cancel_released_worker=false
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 -H "Host: auth.edge.test" \
    "http://127.0.0.1:$CADDY_PORT/api/v1/health" >/dev/null 2>&1; then
    cancel_released_worker=true
    break
  fi
  sleep 0.1
done
if [[ "$cancel_released_worker" != true ]]; then
  echo "Caddy disconnect did not release the Edge Runtime worker" >&2
  cat "$caddy_log" >&2
  cat "$edge_log" >&2
  exit 1
fi

expected_response="/functions/v1/supauth/api/v1/health|auth.edge.test|$PROJECT_REF|auth.edge.test|http|round-trip"
probe_pids=()
for probe_id in $(seq 1 12); do
  curl -fsS \
    -H "Host: auth.edge.test" \
    -H "Content-Type: text/plain" \
    --data 'round-trip' \
    "http://127.0.0.1:$CADDY_PORT/api/v1/health" >"$work_dir/response-$probe_id.txt" &
  probe_pids+=("$!")
done

probe_failed=false
for probe_pid in "${probe_pids[@]}"; do
  if ! wait "$probe_pid"; then
    probe_failed=true
  fi
done

for probe_id in $(seq 1 12); do
  actual_response="$(<"$work_dir/response-$probe_id.txt")"
  if [[ "$actual_response" != "$expected_response" ]]; then
    probe_failed=true
    echo "probe $probe_id: $actual_response" >&2
  fi
done

if [[ "$probe_failed" == true ]]; then
  echo "Unexpected Caddy to Edge Runtime response" >&2
  echo "expected: $expected_response" >&2
  cat "$caddy_log" >&2
  cat "$edge_log" >&2
  exit 1
fi

echo "Caddy disconnect cancellation and 12 concurrent Edge Runtime round-trips passed"

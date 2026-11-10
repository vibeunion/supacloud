#!/usr/bin/env bash

# SupaCloud single-node Podman installer.
#
# Production supervision is Quadlet + systemd.  `podman compose` is an
# optional development compatibility path and is intentionally not invoked by
# this installer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ROOT_PREFIX=""
PUBLIC_URL="http://localhost"
STUDIO_URL="http://localhost:9090"
DRY_RUN=false
SKIP_BUILD=false
START=true

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Installs the single-node SupaCloud profile using Podman Quadlet and systemd.
It provisions the bundled PostgreSQL, Caddy, GoTrue, PostgREST, Realtime,
Management API, Edge Runtime, pgredis runtime and VictoriaLogs components.

Options:
  --public-url URL       Public gateway URL for a new environment
  --studio-url URL       Management/Studio URL for a new environment
  --root-dir PATH        Stage files below PATH (useful for dry-run/tests)
  --dry-run              Render and validate the installation plan only
  --skip-build           Reuse already built local Podman images
  --no-start             Install units without starting systemd
  --help                 Show this help

The default is a single node. Podman Pods and Quadlet do not provide
cross-node scheduling, failover or a cluster; migrate to Kubernetes or Nomad
when those guarantees are required.
EOF
}

while (($# > 0)); do
  case "$1" in
    --public-url)
      [[ $# -ge 2 ]] || { echo "--public-url requires a value" >&2; exit 2; }
      PUBLIC_URL="$2"; shift 2 ;;
    --studio-url)
      [[ $# -ge 2 ]] || { echo "--studio-url requires a value" >&2; exit 2; }
      STUDIO_URL="$2"; shift 2 ;;
    --root-dir)
      [[ $# -ge 2 ]] || { echo "--root-dir requires a value" >&2; exit 2; }
      ROOT_PREFIX="${2%/}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --no-start) START=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$ROOT_PREFIX" ]]; then
  [[ "$ROOT_PREFIX" == /* && "$ROOT_PREFIX" != "/" ]] || {
    echo "--root-dir must be an absolute staging directory" >&2; exit 2;
  }
  [[ "$START" != "true" || "$DRY_RUN" == "true" ]] || {
    echo "--root-dir requires --no-start or --dry-run; staging cannot start host services" >&2; exit 2;
  }
fi

# A dry-run must be usable by an unprivileged developer on a clean host. Stage
# its generated configuration under a temporary prefix instead of writing
# /etc or /var/lib.
if [[ "$DRY_RUN" == "true" && -z "$ROOT_PREFIX" ]]; then
  ROOT_PREFIX="$(mktemp -d "${TMPDIR:-/tmp}/supacloud-podman-dry-run.XXXXXX")"
fi

prefix_path() {
  local path="$1"
  if [[ -n "$ROOT_PREFIX" ]]; then
    printf '%s%s' "$ROOT_PREFIX" "$path"
  else
    printf '%s' "$path"
  fi
}

CONFIG_DIR="$(prefix_path /etc/supacloud)"
STATE_DIR="$(prefix_path /var/lib/supacloud)"
QUADLET_DIR="$(prefix_path /etc/containers/systemd)"
ENV_FILE="${CONFIG_DIR}/supacloud.env"
REALTIME_ENV_FILE="${CONFIG_DIR}/realtime.env"
LEGACY_MIGRATION_FILE="${CONFIG_DIR}/.legacy-secrets-migration.env"
SYSTEMD_DIR="$(prefix_path /etc/systemd/system)"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command is missing: $1" >&2
    return 1
  }
}

install_podman_runtime() {
  if command -v podman >/dev/null 2>&1; then
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y podman
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y podman
  elif command -v yum >/dev/null 2>&1; then
    yum install -y podman
  else
    echo "Podman is not installed and no supported package manager was found; install Podman and rerun." >&2
    return 1
  fi
  require_command podman
}

ensure_quadlet_generator() {
  local candidate
  for candidate in \
    /usr/libexec/podman/quadlet \
    /usr/lib/podman/quadlet \
    /usr/libexec/podman/quadlet-linux; do
    if [[ -x "$candidate" ]]; then
      return 0
    fi
  done
  echo "The installed Podman package does not provide the Quadlet generator; install a Podman package with systemd/Quadlet support." >&2
  return 1
}

if [[ "$DRY_RUN" != "true" ]]; then
  [[ "$(id -u)" -eq 0 ]] || { echo "Run the installer as root." >&2; exit 1; }
  install_podman_runtime
  require_command systemctl
  require_command python3
  ensure_quadlet_generator
else
  require_command python3
fi

if [[ "$DRY_RUN" != "true" || -n "$ROOT_PREFIX" ]]; then
  mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$QUADLET_DIR" "$SYSTEMD_DIR"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  python3 "$SCRIPT_DIR/init-env.py" \
    --public-url "$PUBLIC_URL" \
    --studio-url "$STUDIO_URL" \
    --output "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
[[ ! -L "$ENV_FILE" && -f "$ENV_FILE" ]] || {
  echo "Environment file must be a regular non-symlink: $ENV_FILE" >&2
  exit 1
}
chmod 600 "$ENV_FILE"

read_env() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); value=$0 } END { print value }' "$ENV_FILE"
}

# Existing installation origins are authoritative; rerunning with the CLI's
# localhost defaults must not rewrite Auth redirects or issuer values.
PUBLIC_URL="$(read_env PUBLIC_URL)"
STUDIO_URL="$(read_env STUDIO_URL)"

ensure_env() {
  local key="$1"
  local value="$2"
  KEY="$key" VALUE="$value" ENV_PATH="$ENV_FILE" python3 - <<'PY'
from pathlib import Path
import os

path = Path(os.environ["ENV_PATH"])
key = os.environ["KEY"]
value = os.environ["VALUE"]
lines = path.read_text(encoding="utf-8").splitlines()
found = False
for index, line in enumerate(lines):
    if line.startswith(f"{key}="):
        found = True
        if not line[len(key) + 1:]:
            lines[index] = f"{key}={value}"
        break
if not found:
    lines.append(f"{key}={value}")
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

postgres_password="$(read_env POSTGRES_PASSWORD)"
jwt_secret="$(read_env JWT_SECRET)"
master_token="$(read_env MASTER_TOKEN)"
pgredis_token="$(read_env PGREDIS_RUNTIME_INTERNAL_TOKEN)"
gotrue_key_id="$(read_env GOTRUE_DB_ENCRYPTION_KEY_ID)"
gotrue_key="$(read_env GOTRUE_DB_ENCRYPTION_KEY)"

database_url="postgres://postgres:${postgres_password}@postgres:5432/postgres"
ensure_env SUPACLOUD_DATABASE_URL "$database_url"
ensure_env DATABASE_URL "$database_url"
ensure_env SUPACLOUD_POSTGRES_URL "$database_url"
ensure_env PG_HOST postgres
ensure_env PG_PORT 5432
ensure_env PG_USER postgres
ensure_env PGPASSWORD "$postgres_password"
ensure_env PG_DATABASE postgres
ensure_env NODE_ENV production
ensure_env PORT 9090
ensure_env GOTRUE_SITE_URL "$STUDIO_URL"
ensure_env API_EXTERNAL_URL "${PUBLIC_URL}/auth/v1"
ensure_env GOTRUE_JWT_SECRET "$jwt_secret"
ensure_env GOTRUE_JWT_AUD authenticated
ensure_env GOTRUE_JWT_ISSUER "${PUBLIC_URL}/auth/v1"
ensure_env GOTRUE_JWT_DEFAULT_GROUP_NAME authenticated
ensure_env GOTRUE_JWT_EXP 3600
ensure_env GOTRUE_OPERATOR_TOKEN "$master_token"
ensure_env GOTRUE_DB_DRIVER postgres
ensure_env GOTRUE_DB_DATABASE_URL "$database_url"
ensure_env GOTRUE_MAILER_AUTOCONFIRM true
ensure_env GOTRUE_EXTERNAL_EMAIL_ENABLED true
ensure_env GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED false
ensure_env GOTRUE_SECURITY_DATABASE_ENCRYPTION_ENCRYPT true
ensure_env GOTRUE_SECURITY_DATABASE_ENCRYPTION_ENCRYPTION_KEY_ID "$gotrue_key_id"
ensure_env GOTRUE_SECURITY_DATABASE_ENCRYPTION_ENCRYPTION_KEY "$gotrue_key"
ensure_env GOTRUE_SECURITY_DATABASE_ENCRYPTION_DECRYPTION_KEYS "${gotrue_key_id}:${gotrue_key}"
ensure_env PGRST_DB_URI "$database_url"
ensure_env PGRST_DB_SCHEMAS public,storage,graphql_public
ensure_env PGRST_DB_ANON_ROLE anon
ensure_env PGRST_JWT_SECRET "$jwt_secret"
ensure_env PGRST_SERVER_PROXY_URI "$PUBLIC_URL"
ensure_env CADDY_ADMIN_URL http://caddy:2019
ensure_env CADDY_CONFIG_PATH /etc/supacloud/caddy/config.json
ensure_env CADDY_STATE_DIR /var/lib/supacloud/caddy
ensure_env MANAGEMENT_API_INTERNAL management-api:9090
ensure_env EDGE_RUNTIME_MODE external
ensure_env MANAGEMENT_API_URL http://management-api:9090
ensure_env EDGE_RUNTIME_URL http://edge-runtime:9005
ensure_env EDGE_RUNTIME_INTERNAL edge-runtime:9005
ensure_env EDGE_RUNTIME_BACKGROUND_INTERNAL edge-runtime:9005
ensure_env EDGE_RUNTIME_MASTER_KEY "$master_token"
ensure_env MASTER_TOKEN "$master_token"
ensure_env EDGE_FUNCTIONS_DIR /data/functions
ensure_env TENANTS_DIR /etc/supabase/tenants
ensure_env TENANT_CONFIG_DIR /etc/supabase/tenants
ensure_env PGREDIS_TENANT_CONFIG_DIR /etc/supabase/pgredis-tenants
ensure_env PGREDIS_TENANT_CONFIG_OWNER bun:bun
ensure_env PGREDIS_RUNTIME_INTERNAL_URL http://pgredis-runtime:9010
ensure_env PGREDIS_RUNTIME_INTERNAL_TOKEN "$pgredis_token"
ensure_env PGREDIS_RUNTIME_HOST 0.0.0.0
ensure_env PGREDIS_RUNTIME_PORT 9010
ensure_env PGREDIS_RUNTIME_TENANTS_DIR /etc/supabase/pgredis-tenants
ensure_env SUPACLOUD_LOGS_ENABLED true
ensure_env VICTORIALOGS_URL http://victorialogs:9428
ensure_env S3_STORAGE_TYPE local
ensure_env STORAGE_TYPE local
ensure_env STORAGE_MOUNT_POINT /data/storage
ensure_env SUPACLOUD_REALTIME_ENGINE container
ensure_env REALTIME_ADMIN_URL http://realtime:4000
ensure_env REALTIME_API_SECRET "$jwt_secret"
ensure_env SUPACLOUD_REALTIME_CONTAINER_ENV_FILE "$REALTIME_ENV_FILE"

if [[ ! -f "$REALTIME_ENV_FILE" ]]; then
  realtime_secret_key_base="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  realtime_db_enc_key="$(python3 -c 'import secrets; print(secrets.token_hex(8))')"
  cat > "$REALTIME_ENV_FILE" <<EOF
PORT=4000
DB_HOST=postgres
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=${postgres_password}
DB_USER_REALTIME=postgres
DB_PASS_REALTIME=${postgres_password}
DB_NAME=postgres
DB_AFTER_CONNECT_QUERY=SET search_path TO _realtime
DB_ENC_KEY=${realtime_db_enc_key}
DB_SSL=false
API_JWT_SECRET=${jwt_secret}
JWT_SECRET=${jwt_secret}
SECRET_KEY_BASE=${realtime_secret_key_base}
METRICS_JWT_SECRET=${jwt_secret}
ERL_AFLAGS=-proto_dist inet_tcp
DNS_NODES=
RLIMIT_NOFILE=10000
APP_NAME=realtime
SEED_SELF_HOST=false
RUN_JANITOR=false
SECURE_CHANNELS=false
REGION=us-east-1
DISABLE_HEALTHCHECK_LOGGING=true
EOF
  chmod 600 "$REALTIME_ENV_FILE"
fi
[[ ! -L "$REALTIME_ENV_FILE" && -f "$REALTIME_ENV_FILE" ]] || {
  echo "Realtime environment file must be a regular non-symlink: $REALTIME_ENV_FILE" >&2
  exit 1
}
chmod 600 "$REALTIME_ENV_FILE"

# A recovered environment may predate this file. Create only if absent; never
# truncate an existing one-shot migration key before its database checkpoint.
if [[ ! -e "$LEGACY_MIGRATION_FILE" && ! -L "$LEGACY_MIGRATION_FILE" ]]; then
  (umask 077; : > "$LEGACY_MIGRATION_FILE")
fi
[[ -f "$LEGACY_MIGRATION_FILE" && ! -L "$LEGACY_MIGRATION_FILE" ]] || {
  echo "Legacy migration input must be a regular non-symlink file" >&2; exit 1;
}
chmod 600 "$LEGACY_MIGRATION_FILE"

python3 "$SCRIPT_DIR/render-env.py" "$CONFIG_DIR"

for directory in \
  "$STATE_DIR/postgres" "$STATE_DIR/tenants" "$STATE_DIR/pgredis-tenants" \
  "$STATE_DIR/functions" "$STATE_DIR/storage" "$STATE_DIR/frontends" \
  "$STATE_DIR/caddy" "$STATE_DIR/caddy-state" "$STATE_DIR/victorialogs"; do
  mkdir -p "$directory"
done

# Render the same supporting files for dry-runs and real installs.
mkdir -p "$(prefix_path /etc/supacloud/podman/caddy)"
install -m 0644 "$SCRIPT_DIR/caddy/Caddyfile" "$(prefix_path /etc/supacloud/podman/caddy/Caddyfile)"
install -m 0755 "$SCRIPT_DIR/wait-health.sh" "$(prefix_path /etc/supacloud/podman/wait-health.sh)"

if [[ "$SKIP_BUILD" != "true" && "$DRY_RUN" != "true" ]]; then
  case "$(uname -m)" in
    x86_64) image_arch=amd64 ;;
    aarch64|arm64) image_arch=arm64 ;;
    *) echo "Unsupported Podman image architecture" >&2; exit 1 ;;
  esac
  podman build --pull=missing --build-arg "TARGETARCH=$image_arch" -f "$SCRIPT_DIR/postgres/Containerfile" -t localhost/supacloud-postgres:local "$SCRIPT_DIR/postgres"
  podman build --pull=missing -f "$SCRIPT_DIR/management-api.Containerfile" -t localhost/supacloud-management-api:local "$REPO_ROOT"
  podman build --pull=missing -f "$SCRIPT_DIR/edge-runtime.Containerfile" -t localhost/supacloud-edge-runtime:local "$REPO_ROOT"
  podman build --pull=missing -f "$SCRIPT_DIR/pgredis-runtime.Containerfile" -t localhost/supacloud-pgredis-runtime:local "$REPO_ROOT"
  podman build --pull=missing -f "$SCRIPT_DIR/caddy/Containerfile" -t localhost/supacloud-caddy:local "$SCRIPT_DIR/caddy"
fi

if [[ "$DRY_RUN" != "true" || -n "$ROOT_PREFIX" ]]; then
  for unit in "$SCRIPT_DIR"/quadlet/*.container "$SCRIPT_DIR"/quadlet/*.network; do
    install -m 0644 "$unit" "$QUADLET_DIR/$(basename "$unit")"
  done
  install -m 0644 "$SCRIPT_DIR/systemd/supacloud.target" "$SYSTEMD_DIR/supacloud.target"
fi

if [[ "$START" == "true" && "$DRY_RUN" != "true" ]]; then
  systemctl daemon-reload
  systemctl enable --now supacloud.target
fi

echo "Podman Quadlet plan ready."
echo "  config: $ENV_FILE"
echo "  state:  $STATE_DIR"
echo "  units:  $QUADLET_DIR"
echo "  target: supacloud.target"
echo "  mode:   single-node (no cross-node scheduling or failover)"

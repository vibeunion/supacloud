#!/usr/bin/env bash
set -euo pipefail

ETL_REPOSITORY="${SUPACLOUD_ETL_REPOSITORY:-https://github.com/supabase/etl.git}"
ETL_COMMIT="${SUPACLOUD_ETL_COMMIT:-cd49f6f8355c75c30c0d191542677bf6bc155607}"
ETL_IMAGE="${SUPACLOUD_ETL_IMAGE:-supacloud/etl-replicator:${ETL_COMMIT:0:12}}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

if ! command -v git >/dev/null 2>&1 || ! command -v podman >/dev/null 2>&1; then
  printf 'git and podman are required to install Supabase ETL\n' >&2
  exit 1
fi
if [[ ! "$ETL_COMMIT" =~ ^[0-9a-f]{40}$ ]] || [[ ! "$ETL_IMAGE" =~ ^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$ ]]; then
  printf 'SUPACLOUD_ETL_COMMIT or SUPACLOUD_ETL_IMAGE is invalid\n' >&2
  exit 1
fi

git clone --filter=blob:none --no-checkout "$ETL_REPOSITORY" "$WORK_DIR/etl"
git -C "$WORK_DIR/etl" fetch --depth 1 origin "$ETL_COMMIT"
git -C "$WORK_DIR/etl" checkout --detach "$ETL_COMMIT"

podman build \
  --file "$WORK_DIR/etl/crates/etl-replicator/Dockerfile" \
  --tag "$ETL_IMAGE" \
  "$WORK_DIR/etl"

install -d -m 0700 /etc/supabase/pipelines
install -m 0644 "$SCRIPT_DIR/../infrastructure/systemd/supacloud-pipeline@.service" /etc/systemd/system/supacloud-pipeline@.service
sed -i "s|^Environment=SUPACLOUD_ETL_IMAGE=.*|Environment=SUPACLOUD_ETL_IMAGE=${ETL_IMAGE}|" /etc/systemd/system/supacloud-pipeline@.service
systemctl daemon-reload

printf 'Installed %s and supacloud-pipeline@.service\n' "$ETL_IMAGE"

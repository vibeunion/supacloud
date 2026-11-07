#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_PIGSTY_VERSION="${EXPECTED_PIGSTY_VERSION:-v4.5.0}"
MAX_BACKUP_AGE_SECONDS="${SUPACLOUD_BACKUP_MAX_AGE_SECONDS:-86400}"

fail() {
  printf '[FAIL] %s\n' "$1" >&2
  exit 1
}

[[ "$EXPECTED_PIGSTY_VERSION" == "v4.5.0" ]] || fail "This gate only supports the pinned Pigsty v4.5.0 baseline"
command -v bun >/dev/null 2>&1 || fail "bun is required"
command -v sudo >/dev/null 2>&1 || fail "sudo is required for host checks"
command -v psql >/dev/null 2>&1 || fail "psql is required for PostgreSQL version read-back"

for script in \
  "$ROOT/install.sh" \
  "$ROOT/scripts/upgrade_pigsty.sh" \
  "$ROOT/scripts/upgrade_pigsty_4_4_compat.sh" \
  "$ROOT/scripts/lib/backup_manager.sh"; do
  bash -n "$script"
done

server_version_num="$(sudo -u postgres psql -Atqc 'show server_version_num')"
[[ "$server_version_num" =~ ^18[0-9]+$ ]] || fail "PostgreSQL 18 is required; read back ${server_version_num:-unknown}"

if [[ -f "$ROOT/scripts/upgrade_pigsty_4_4_compat.sh" ]]; then
  sudo bash "$ROOT/scripts/upgrade_pigsty_4_4_compat.sh" --check
fi

bun "$ROOT/scripts/verify-pigsty-backup-acceptance.ts" --max-age-seconds "$MAX_BACKUP_AGE_SECONDS"

failed_units="$(systemctl --failed --no-legend --plain 2>/dev/null || true)"
[[ -z "$failed_units" ]] || fail "systemd has failed units:\n${failed_units}"

printf '{"schema":"supacloud.pigsty-upgrade-acceptance.v1","status":"confirmed","pigsty":"%s","postgres_major":18}\n' "$EXPECTED_PIGSTY_VERSION"

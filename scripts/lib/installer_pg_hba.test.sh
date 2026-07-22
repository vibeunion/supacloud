#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/pigsty" "$tmp_dir/bin"
cat > "$tmp_dir/pigsty/pigsty.yml" <<'YAML'
all:
  vars:
    pg_hba_rules:
      - { user: dbuser_monitor, db: all, addr: localhost, auth: pwd, order: 350, title: monitor }
      - { user: all, db: all, addr: 10.88.0.0/16, auth: pwd, order: 800, title: existing container access }
    unrelated_setting: keep-me
YAML
touch "$tmp_dir/pigsty/pgsql.yml"
cat > "$tmp_dir/bin/ansible-playbook" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ANSIBLE_LOG"
SH
chmod 755 "$tmp_dir/bin/ansible-playbook"

ANSIBLE_LOG="$tmp_dir/ansible.log"
export ANSIBLE_LOG
PATH="$tmp_dir/bin:$PATH"
export PATH
PIGSTY_PATH="$tmp_dir/pigsty"
export PIGSTY_PATH

# shellcheck source=../../install.sh
source "$SCRIPT_DIR/install.sh"

ensure_pigsty_tenant_hba_rule
grep -Fq "SupaCloud tenant authenticator loopback" "$PIGSTY_PATH/pigsty.yml"
grep -Fq "user: '/^authenticator_[a-z0-9-]+$/'" "$PIGSTY_PATH/pigsty.yml"
grep -Fq "db: '/^supa_[a-z0-9-]+$/'" "$PIGSTY_PATH/pigsty.yml"
grep -Fq "addr: 127.0.0.1/32, auth: pwd, order: 40" "$PIGSTY_PATH/pigsty.yml"
grep -Fq "unrelated_setting: keep-me" "$PIGSTY_PATH/pigsty.yml"
grep -Fq "addr: 10.88.0.0/16" "$PIGSTY_PATH/pigsty.yml"
[[ "$(grep -Fc "SupaCloud tenant authenticator loopback" "$PIGSTY_PATH/pigsty.yml")" == 1 ]]
grep -Fq -- "-i $PIGSTY_PATH/pigsty.yml $PIGSTY_PATH/pgsql.yml -l pg-meta --tags=pg_hba -e pg_reload=true" "$ANSIBLE_LOG"

# Idempotent reruns still render the durable inventory through Pigsty.
ensure_pigsty_tenant_hba_rule
[[ "$(grep -Fc "SupaCloud tenant authenticator loopback" "$PIGSTY_PATH/pigsty.yml")" == 1 ]]
[[ "$(wc -l < "$ANSIBLE_LOG" | tr -d ' ')" == 2 ]]

bad_config="$tmp_dir/bad.yml"
printf 'all:\n  vars:\n    unrelated: true\n' > "$bad_config"
if PIGSTY_CONFIG="$bad_config" ensure_pigsty_tenant_hba_rule >/dev/null 2>&1; then
    echo "inventory without pg_hba_rules was accepted" >&2
    exit 1
fi
! grep -Fq "SupaCloud tenant authenticator loopback" "$bad_config"

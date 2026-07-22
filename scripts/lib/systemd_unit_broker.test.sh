#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/requests" "$TMP_DIR/units"

cat > "$TMP_DIR/bin/install" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source_file="$3"; target="$4"
[[ "$1" == "-m" && "$2" == "0644" ]] || exit 2
mkdir -p "$(dirname "$target")"
cp "$source_file" "$target"
SH
cat > "$TMP_DIR/bin/systemctl" <<'SH'
#!/usr/bin/env bash
[[ "$1" == "daemon-reload" ]] || exit 2
SH
chmod 755 "$TMP_DIR/bin/"*

token=01234567-89ab-cdef-0123-456789abcdef
printf 'operation=install\nunit_name=supacloud-pgrst@.service\n' > "$TMP_DIR/requests/$token.request"
printf '[Unit]\nDescription=test\n[Service]\nType=oneshot\nUser=supacloud-%%i\nGroup=supacloud-%%i\nNoNewPrivileges=true\nEnvironmentFile=/etc/supabase/tenants/%%i.env\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n' > "$TMP_DIR/requests/$token.unit"

sed \
  -e "s#request_dir=\"/run/supacloud-unit-requests\"#request_dir=\"$TMP_DIR/requests\"#" \
  -e "s#/etc/systemd/system/#$TMP_DIR/units/#g" \
  "$ROOT_DIR/scripts/lib/systemd_unit_broker.sh" > "$TMP_DIR/broker.sh"
PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token"
grep -Fq 'ExecStart=/bin/true' "$TMP_DIR/units/supacloud-pgrst@.service"
[[ ! -e "$TMP_DIR/requests/$token.request" ]]
[[ ! -e "$TMP_DIR/requests/$token.unit" ]]

printf 'operation=remove\nunit_name=supacloud-pgrst@.service\n' > "$TMP_DIR/requests/$token.request"
PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token"
[[ ! -e "$TMP_DIR/units/supacloud-pgrst@.service" ]]

printf 'operation=install\nunit_name=evil.service\n' > "$TMP_DIR/requests/$token.request"
printf '[Service]\nExecStart=/bin/sh\n' > "$TMP_DIR/requests/$token.unit"
if PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token" >/dev/null 2>&1; then
  echo "broker accepted an unapproved unit name" >&2
  exit 1
fi

printf 'operation=install\nunit_name=supacloud-pgrst@.service\n' > "$TMP_DIR/requests/$token.request"
printf '[Unit]\nDescription=test\n[Service]\nType=oneshot\nUser=root\nGroup=root\nNoNewPrivileges=true\nEnvironmentFile=/etc/supabase/tenants/%%i.env\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n' > "$TMP_DIR/requests/$token.unit"
if PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token" >/dev/null 2>&1; then
  echo "broker accepted a root systemd identity" >&2
  exit 1
fi

printf 'operation=install\nunit_name=supacloud-pgrst@.service\n' > "$TMP_DIR/requests/$token.request"
printf '[Unit]\nDescription=test\n[Service]\nType=oneshot\nUser=supacloud-%%i\nGroup=supacloud-%%i\nNoNewPrivileges=true\nEnvironmentFile=/etc/supabase/tenants/%%i.env\nExecStartPre=/bin/sh\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n' > "$TMP_DIR/requests/$token.unit"
if PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token" >/dev/null 2>&1; then
  echo "broker accepted an unsupported systemd directive" >&2
  exit 1
fi

printf 'operation=install\nunit_name=supacloud-pgrst@.service\n' > "$TMP_DIR/requests/$token.request"
printf '[Unit]\nDescription=bad\001value\n[Service]\nType=oneshot\nUser=supacloud-%%i\nGroup=supacloud-%%i\nNoNewPrivileges=true\nEnvironmentFile=/etc/supabase/tenants/%%i.env\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n' > "$TMP_DIR/requests/$token.unit"
if PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token" >/dev/null 2>&1; then
  echo "broker accepted a control character" >&2
  exit 1
fi

printf 'operation=install\nunit_name=supacloud-pgrst@.service\n' > "$TMP_DIR/requests/$token.request"
printf '[Unit]\nDescription=test\n[Service]\nType=oneshot\nUser=supacloud-%%i\nGroup=supacloud-%%i\nNoNewPrivileges=true\nEnvironmentFile=-/etc/supabase/management-api.env\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n' > "$TMP_DIR/requests/$token.unit"
if PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token" >/dev/null 2>&1; then
  echo "broker accepted the control-plane environment file" >&2
  exit 1
fi

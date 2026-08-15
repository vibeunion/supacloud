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

render_canonical_postgrest_unit() {
  (
    cd "$ROOT_DIR/packages/management-api"
    bun -e '
      import { renderPostgrestSystemdTemplate } from "./src/services/postgrest-systemd-template";
      process.stdout.write(renderPostgrestSystemdTemplate({
        postgrestRts: "-N2 -A8m",
        postgrestBinary: "/opt/supacloud/postgrest-v16.1/bin/postgrest",
        tenantConfigDir: "/etc/supabase/tenants",
        memoryMax: "64M",
        cpuWeight: 20,
      }));
    '
  )
}

token=01234567-89ab-cdef-0123-456789abcdef
printf 'operation=install\nunit_name=supacloud-pgrst@.service\n' > "$TMP_DIR/requests/$token.request"
render_canonical_postgrest_unit > "$TMP_DIR/requests/$token.unit"

sed \
  -e "s#request_dir=\"/run/supacloud-unit-requests\"#request_dir=\"$TMP_DIR/requests\"#" \
  -e "s#/etc/systemd/system/#$TMP_DIR/units/#g" \
  "$ROOT_DIR/scripts/lib/systemd_unit_broker.sh" > "$TMP_DIR/broker.sh"
PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token"
grep -Fq 'ExecStart=/usr/local/libexec/supacloud/postgrest-launcher %i' "$TMP_DIR/units/supacloud-pgrst@.service"
[[ ! -e "$TMP_DIR/requests/$token.request" ]]
[[ ! -e "$TMP_DIR/requests/$token.unit" ]]

printf 'operation=install\nunit_name=supacloud-pgrst@.service\n' > "$TMP_DIR/requests/$token.request"
printf '[Unit]\nDescription=test\n[Service]\nType=oneshot\nUser=supacloud-%%i\nGroup=supacloud-%%i\nNoNewPrivileges=true\nEnvironmentFile=/etc/supabase/tenants/%%i.env\nExecStart=/usr/local/libexec/supacloud/postgrest-launcher %%i\n[Install]\nWantedBy=multi-user.target\n' > "$TMP_DIR/requests/$token.unit"
PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token"
grep -Fq 'EnvironmentFile=/etc/supabase/tenants/%i.env' "$TMP_DIR/units/supacloud-pgrst@.service"

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
printf '[Unit]\nDescription=test\n[Service]\nType=oneshot\nUser=supacloud-%%i\nGroup=supacloud-%%i\nNoNewPrivileges=true\nExecStart=+/bin/true\n[Install]\nWantedBy=multi-user.target\n' > "$TMP_DIR/requests/$token.unit"
if PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token" >/dev/null 2>&1; then
  echo "broker accepted a privileged execution prefix" >&2
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

printf 'operation=install\nunit_name=supacloud-pgrst@.service\n' > "$TMP_DIR/requests/$token.request"
printf '[Unit]\nDescription=test\n[Service]\nType=oneshot\nUser=supacloud-%%i\nGroup=supacloud-%%i\nNoNewPrivileges=true\nEnvironmentFile=/etc/supabase/tenants/%%i.env\nEnvironmentFile=/etc/supabase/tenants/%%i.env\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n' > "$TMP_DIR/requests/$token.unit"
if PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token" >/dev/null 2>&1; then
  echo "broker accepted duplicate PostgREST environment files" >&2
  exit 1
fi

printf 'operation=install\nunit_name=supacloud-gotrue@.service\n' > "$TMP_DIR/requests/$token.request"
printf '[Unit]\nDescription=test\n[Service]\nType=oneshot\nUser=supacloud-%%i\nGroup=supacloud-%%i\nNoNewPrivileges=true\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n' > "$TMP_DIR/requests/$token.unit"
if PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token" >/dev/null 2>&1; then
  echo "broker accepted a GoTrue unit without its environment file" >&2
  exit 1
fi


printf 'operation=install\nunit_name=supacloud-frontend-demo-abc123ff.service\n' > "$TMP_DIR/requests/$token.request"
printf '[Unit]\nDescription=test\n[Service]\nType=oneshot\nUser=supacloud-demo\nGroup=supacloud-demo\nNoNewPrivileges=true\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n' > "$TMP_DIR/requests/$token.unit"
if PATH="$TMP_DIR/bin:$PATH" bash "$TMP_DIR/broker.sh" "$token" >/dev/null 2>&1; then
  echo "broker accepted a frontend unit without its environment file" >&2
  exit 1
fi

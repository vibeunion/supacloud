#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin"

cat > "$TMP_DIR/bin/nologin" <<'SH'
#!/usr/bin/env bash
exit 1
SH
cat > "$TMP_DIR/bin/getent" <<'SH'
#!/usr/bin/env bash
case "$1" in
  passwd) [[ -n "${PASSWD_ENTRY:-}" ]] && printf '%s\n' "$PASSWD_ENTRY" || exit 2 ;;
  group) [[ -n "${GROUP_ENTRY:-}" ]] && printf '%s\n' "$GROUP_ENTRY" || exit 2 ;;
  *) exit 2 ;;
esac
SH
cat > "$TMP_DIR/bin/useradd" <<'SH'
#!/usr/bin/env bash
echo "unexpected useradd" >&2
exit 99
SH
chmod 755 "$TMP_DIR/bin/"*

run_helper() {
  PATH="$TMP_DIR/bin:/usr/bin:/bin" \
    PASSWD_ENTRY="$1" GROUP_ENTRY="$2" \
    bash "$ROOT_DIR/scripts/lib/tenant_user.sh" demo
}

run_helper \
  "supacloud-demo:x:998:998::/nonexistent:$TMP_DIR/bin/nologin" \
  "supacloud-demo:x:998:"

if run_helper \
  "supacloud-demo:x:998:998::/home/demo:/bin/bash" \
  "supacloud-demo:x:998:" >/dev/null 2>&1; then
  echo "unsafe login-capable tenant account was accepted" >&2
  exit 1
fi

if run_helper \
  "supacloud-demo:x:1000:1000::/nonexistent:$TMP_DIR/bin/nologin" \
  "supacloud-demo:x:1000:" >/dev/null 2>&1; then
  echo "non-system tenant account was accepted" >&2
  exit 1
fi

if run_helper \
  "supacloud-demo:x:998:997::/nonexistent:$TMP_DIR/bin/nologin" \
  "supacloud-demo:x:998:" >/dev/null 2>&1; then
  echo "tenant account with mismatched primary group was accepted" >&2
  exit 1
fi

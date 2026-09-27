#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=scripts/lib/application_bun_runtime.sh
source "$ROOT_DIR/scripts/lib/application_bun_runtime.sh"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/home/bin"
printf '#!/bin/sh\nprintf "1.4.2\\n"\n' > "$TMP_DIR/home/bin/bun"
chmod 0755 "$TMP_DIR/home/bin/bun"
umask 0077
install_application_bun_runtime "$TMP_DIR/home/bin/bun" "1.4.2" "$TMP_DIR/runtime"
install_application_bun_runtime "$TMP_DIR/home/bin/bun" "1.4.2" "$TMP_DIR/runtime"
[[ ! -L "$TMP_DIR/runtime/1.4.2/bun" ]]
[[ "$("$TMP_DIR/runtime/1.4.2/bun" --version)" == "1.4.2" ]]
[[ "$(ls -ld "$TMP_DIR/runtime/1.4.2/bun" | cut -c 1-10)" == "-rwxr-xr-x" ]]
rm -rf "$TMP_DIR/home"
[[ "$("$TMP_DIR/runtime/1.4.2/bun" --version)" == "1.4.2" ]]
if install_application_bun_runtime "$TMP_DIR/runtime/1.4.2/bun" "1.4.3" "$TMP_DIR/runtime"; then
    echo "accepted an unexpected Bun version" >&2
    exit 1
fi

# Source only the installer functions; main is guarded when sourced.
# shellcheck source=../../install.sh
source "$ROOT_DIR/install.sh"
log_info() { :; }
log_warn() { :; }
install_application_bun_runtime() { return 1; }
bun() { printf '1.4.2\n'; }
BUN_VERSION=1.4.2
if ensure_bun_version; then
    echo "installer ignored runtime installation failure for an existing Bun" >&2
    exit 1
fi

bun() {
    if [[ -e "$TMP_DIR/upgraded" ]]; then printf '1.4.2\n'; else printf '1.0.0\n'; fi
}
unzip() { :; }
ln() { :; }
curl() { touch "$TMP_DIR/upgraded"; printf 'true\n'; }
if ensure_bun_version; then
    echo "installer ignored runtime installation failure after upgrading Bun" >&2
    exit 1
fi

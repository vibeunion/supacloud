#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/source" "$tmp/release/bin" "$tmp/out"
printf 'Apache License\n' > "$tmp/source/LICENSE"
printf '#!/bin/sh\nexit 0\n' > "$tmp/release/bin/server"
printf '#!/bin/sh\nexit 0\n' > "$tmp/release/bin/migrate"
chmod 0755 "$tmp/release/bin/server" "$tmp/release/bin/migrate"

bash "$root/scripts/package_realtime_native_release.sh" \
  "$tmp/source" "$tmp/release" 2.150.0 0123456789abcdef0123456789abcdef01234567 "$tmp/out" linux-amd64 >/dev/null

archive="$tmp/out/supacloud-realtime-2.150.0-linux-amd64.tar.zst"
manifest="$tmp/out/SUPACLOUD-REALTIME-2.150.0-linux-amd64.json"
[[ -s "$archive" && -s "$manifest" && -s "$tmp/out/SHA256SUMS" ]]
tar --zstd -tf "$archive" | grep -Fx './release/bin/server' >/dev/null
tar --zstd -tf "$archive" | grep -Fx './supacloud-realtime' >/dev/null
grep -Fq '"format": "otp-release"' "$manifest"
(cd "$tmp/out" && sha256sum -c SHA256SUMS >/dev/null)
printf '%s\n' 'realtime-native-release-package-ok'

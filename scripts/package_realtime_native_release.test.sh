#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/source" "$tmp/release/bin" "$tmp/release/releases/2.150.0" "$tmp/out"
printf 'Apache License\n' > "$tmp/source/LICENSE"
printf 'fixture\n' > "$tmp/release/releases/2.150.0/realtime.rel"
cat > "$tmp/release/bin/server" <<'EOF'
#!/bin/sh
printf 'server:%s\n' "$1"
EOF
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
mkdir -p "$tmp/extracted"
tar --zstd -xf "$archive" -C "$tmp/extracted"
[[ "$("$tmp/extracted/supacloud-realtime" probe)" == "server:probe" ]]
"$tmp/extracted/supacloud-realtime-migrate"

if bash "$root/scripts/package_realtime_native_release.sh" \
  "$tmp/source" "$tmp/release" 2.151.0 0123456789abcdef0123456789abcdef01234567 "$tmp/mismatch" \
  > "$tmp/rejected.log" 2>&1; then
    echo 'Mismatched release version was accepted' >&2
    exit 1
fi
grep -Fq 'version does not match' "$tmp/rejected.log"
[[ ! -e "$tmp/mismatch" ]]

printf 'tampered\n' >> "$archive"
if (cd "$tmp/out" && sha256sum -c SHA256SUMS > /dev/null 2>&1); then
    echo 'Tampered release archive passed checksum validation' >&2
    exit 1
fi
printf '%s\n' 'realtime-native-release-package-ok'

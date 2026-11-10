#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat >&2 <<'EOF'
Usage: package_realtime_native_release.sh <source-dir> <release-dir> <version> <source-commit> <output-dir> [platform]
EOF
}

[[ $# -ge 5 && $# -le 6 ]] || { usage; exit 2; }

source_dir=$1
release_dir=$2
version=$3
source_commit=$4
output_dir=$5
platform=${6:-linux-amd64}

[[ -d "$source_dir" && ! -L "$source_dir" ]] || { echo "Realtime source directory is missing or symlinked" >&2; exit 1; }
[[ -d "$release_dir" && ! -L "$release_dir" ]] || { echo "Realtime release directory is missing or symlinked" >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Realtime version must be stable semver" >&2; exit 1; }
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "Realtime source commit must be a lowercase Git SHA" >&2; exit 1; }
[[ "$platform" =~ ^(linux-amd64|linux-arm64)$ ]] || { echo "Unsupported Realtime platform: $platform" >&2; exit 1; }
[[ -x "$release_dir/bin/server" && -x "$release_dir/bin/migrate" ]] || {
    echo "Realtime OTP release must contain executable bin/server and bin/migrate" >&2
    exit 1
}
[[ -f "$release_dir/releases/$version/realtime.rel" ]] || {
    echo "Realtime OTP release version does not match $version" >&2
    exit 1
}
[[ -f "$source_dir/LICENSE" && ! -L "$source_dir/LICENSE" ]] || {
    echo "Upstream Realtime LICENSE is required" >&2
    exit 1
}
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
command -v zstd >/dev/null 2>&1 || { echo "zstd is required" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }

mkdir -p "$output_dir"
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT HUP INT TERM
mkdir -p "$staging/release"
cp -a "$release_dir"/. "$staging/release"/

cat > "$staging/supacloud-realtime" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec "$root/release/bin/server" "$@"
EOF
cat > "$staging/supacloud-realtime-migrate" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec "$root/release/bin/migrate" "$@"
EOF
chmod 0755 "$staging/supacloud-realtime" "$staging/supacloud-realtime-migrate"

cp "$source_dir/LICENSE" "$staging/LICENSE"
if [[ -f "$source_dir/NOTICE" ]]; then cp "$source_dir/NOTICE" "$staging/NOTICE"; fi

manifest_path="$staging/SUPACLOUD-REALTIME.json"
cat > "$manifest_path" <<EOF
{
  "schema": "supacloud.realtime-native-release.v1",
  "component": "realtime",
  "version": "$version",
  "platform": "$platform",
  "format": "otp-release",
  "source": {
    "repository": "supabase/realtime",
    "ref": "refs/tags/v$version",
    "commit": "$source_commit"
  },
  "entrypoint": "supacloud-realtime",
  "migration": "supacloud-realtime-migrate"
}
EOF

archive="$output_dir/supacloud-realtime-${version}-${platform}.tar.zst"
manifest="$output_dir/SUPACLOUD-REALTIME-${version}-${platform}.json"
tar_options=(--zstd -cf)
if tar --help 2>&1 | grep -q -- '--sort'; then
    tar_options=(--sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner --zstd -cf)
fi
tar "${tar_options[@]}" "$archive" -C "$staging" .
cp "$manifest_path" "$manifest"

(
    cd "$output_dir"
    sha256sum "$(basename "$archive")" "$(basename "$manifest")" > SHA256SUMS
)
printf '%s\n' "$archive"

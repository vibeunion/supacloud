#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=edge_runtime_source.sh
source "${SCRIPT_DIR}/edge_runtime_source.sh"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

make_source() {
    local directory="$1"
    local version="$2"
    mkdir -p "$directory/shims" "$directory/node_modules/ignored-package" "$directory/.tmp"
    printf '{"name":"@supacloud/edge-runtime","version":"%s"}\n' "$version" > "$directory/package.json"
    printf 'export const runtime = "%s";\n' "$version" > "$directory/server.ts"
    printf 'export const shim = true;\n' > "$directory/shims/runtime.ts"
    printf 'ignored dependency\n' > "$directory/node_modules/ignored-package/index.js"
    printf 'ignored build output\n' > "$directory/.tmp/output.js"
}

source_one="$tmp_dir/source-one"
target="$tmp_dir/edge-runtime"
make_source "$source_one" "1.2.3"
mkdir -p "$target/node_modules"
printf '{"name":"@supacloud/edge-runtime","version":"1.0.0"}\n' > "$target/package.json"
printf 'old runtime\n' > "$target/server.ts"
printf 'must be removed\n' > "$target/removed.ts"
printf 'old dependency\n' > "$target/node_modules/keep-on-rollback.js"

transaction=$(supacloud_stage_edge_runtime_source "$source_one" "$target")
expected=$(supacloud_edge_runtime_transaction_identity "$transaction")
IFS=$'\t' read -r expected_version expected_sha256 <<< "$expected"
[[ "$expected_version" == "1.2.3" ]]
[[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]]
supacloud_verify_edge_runtime_source_identity "$transaction/staged" "$expected_version" "$expected_sha256"
supacloud_activate_edge_runtime_source "$transaction" "$target"
[[ -f "$target/server.ts" ]]
[[ ! -e "$target/removed.ts" ]]
[[ ! -e "$target/node_modules/keep-on-rollback.js" ]]
[[ ! -e "$target/node_modules" ]]
supacloud_verify_edge_runtime_source_identity "$target" "$expected_version" "$expected_sha256"
supacloud_commit_edge_runtime_source "$transaction" "$target"
[[ ! -e "$transaction" ]]

source_two="$tmp_dir/source-two"
make_source "$source_two" "1.2.4"
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
supacloud_activate_edge_runtime_source "$transaction" "$target"
grep -Fq '1.2.4' "$target/server.ts"
supacloud_rollback_edge_runtime_source "$transaction" "$target"
grep -Fq '1.2.3' "$target/server.ts"
supacloud_verify_edge_runtime_source_identity "$target" "$expected_version" "$expected_sha256"

absent_target="$tmp_dir/first-install"
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$absent_target")
supacloud_activate_edge_runtime_source "$transaction" "$absent_target"
[[ -d "$absent_target" ]]
supacloud_rollback_edge_runtime_source "$transaction" "$absent_target"
[[ ! -e "$absent_target" ]]

transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
supacloud_activate_edge_runtime_source "$transaction" "$target"
printf 'tampered\n' >> "$target/server.ts"
if supacloud_read_edge_runtime_source_identity "$target" >/dev/null 2>&1; then
    echo "tampered Edge Runtime source passed identity read-back" >&2
    exit 1
fi
printf 'export const runtime = "1.2.4";\n' > "$target/server.ts"
supacloud_rollback_edge_runtime_source "$transaction" "$target"
grep -Fq '1.2.3' "$target/server.ts"

unsafe_source="$tmp_dir/unsafe-source"
make_source "$unsafe_source" "1.2.5"
ln -s /etc/passwd "$unsafe_source/escape.ts"
if supacloud_stage_edge_runtime_source "$unsafe_source" "$target" >/dev/null 2>&1; then
    echo "Edge Runtime source staging accepted a symbolic link" >&2
    exit 1
fi

invalid_source="$tmp_dir/invalid-source"
make_source "$invalid_source" "1.2.5-beta.1"
if supacloud_stage_edge_runtime_source "$invalid_source" "$target" >/dev/null 2>&1; then
    echo "Edge Runtime source staging accepted a non-stable package version" >&2
    exit 1
fi

identity_source="$tmp_dir/identity-source"
make_source "$identity_source" "1.2.6"
if SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_NAME="$tmp_dir/outside.json" \
    supacloud_stage_edge_runtime_source "$identity_source" "$target" >/dev/null 2>&1; then
    echo "Edge Runtime staging accepted an absolute identity path" >&2
    exit 1
fi
if SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_NAME="../outside.json" \
    supacloud_stage_edge_runtime_source "$identity_source" "$target" >/dev/null 2>&1; then
    echo "Edge Runtime staging accepted a traversing identity path" >&2
    exit 1
fi

transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
staged_identity=$(supacloud_edge_runtime_transaction_identity "$transaction")
chmod 0664 "$transaction/staged/server.ts"
refreshed_identity=$(supacloud_refresh_edge_runtime_source_identity "$transaction/staged")
[[ "$refreshed_identity" != "$staged_identity" ]]
printf '%s\n' "$refreshed_identity" > "$transaction/expected-identity"
IFS=$'\t' read -r refreshed_version refreshed_sha256 <<< "$refreshed_identity"
supacloud_verify_edge_runtime_source_identity \
    "$transaction/staged" "$refreshed_version" "$refreshed_sha256"
supacloud_rollback_edge_runtime_source "$transaction" "$target"

health_sha256="$expected_sha256"
curl() {
    printf '{"status":"ok","packageVersion":"%s","sourceSha256":"%s"}\n' "$expected_version" "$health_sha256"
}
sleep() { :; }
supacloud_wait_edge_runtime_source_identity \
    http://127.0.0.1:9005/health "$expected_version" "$expected_sha256" 1 0
health_sha256="$(printf '0%.0s' {1..64})"
if supacloud_wait_edge_runtime_source_identity \
    http://127.0.0.1:9005/health "$expected_version" "$expected_sha256" 1 0; then
    echo "Edge Runtime health read-back accepted a different source digest" >&2
    exit 1
fi

curl() {
    printf '{"status":"ok","packageVersion":"%s","sourceSha256":null}\n' "$expected_version"
}
supacloud_wait_edge_runtime_compiled_identity \
    http://127.0.0.1:9005/health "$expected_version" 1 0
curl() {
    printf '{"status":"ok","packageVersion":"%s","sourceSha256":"%s"}\n' "$expected_version" "$expected_sha256"
}
if supacloud_wait_edge_runtime_compiled_identity \
    http://127.0.0.1:9005/health "$expected_version" 1 0; then
    echo "Compiled Edge Runtime health accepted a source digest" >&2
    exit 1
fi

echo "Edge Runtime source transaction checks passed"

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
supacloud_refresh_edge_runtime_source_identity "$target" >/dev/null

reset_target_to_source_one() {
    rm -rf -- "$target"
    mkdir -p "$target"
    cp -R "$source_one"/. "$target"/
    supacloud_refresh_edge_runtime_source_identity "$target" >/dev/null
}

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
[[ "$(supacloud_edge_runtime_source_transaction_outcome "$transaction")" == commit ]]
supacloud_commit_edge_runtime_source "$transaction" "$target"
[[ "$(supacloud_edge_runtime_source_transaction_outcome "$transaction")" == commit ]]
supacloud_clear_edge_runtime_source_transaction_outcome "$transaction" commit

source_two="$tmp_dir/source-two"
make_source "$source_two" "1.2.4"

# A pre-activation rollback tombstone resumes from the prepared state.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
supacloud_remove_edge_runtime_source_transaction "$transaction" rollback "$target"
[[ ! -e "$transaction" && -d "${transaction}.cleanup" ]]
[[ "$(<"${transaction}.cleanup/state")" == prepared ]]
supacloud_rollback_edge_runtime_source "$transaction" "$target"
[[ ! -e "$transaction" && ! -e "${transaction}.cleanup" ]]
supacloud_clear_edge_runtime_source_transaction_outcome "$transaction" rollback

transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
supacloud_activate_edge_runtime_source "$transaction" "$target"
grep -Fq '1.2.4' "$target/server.ts"
supacloud_rollback_edge_runtime_source "$transaction" "$target"
grep -Fq '1.2.3' "$target/server.ts"
[[ "$(supacloud_edge_runtime_source_transaction_outcome "$transaction")" == rollback ]]
supacloud_rollback_edge_runtime_source "$transaction" "$target"
[[ "$(supacloud_edge_runtime_source_transaction_outcome "$transaction")" == rollback ]]
supacloud_clear_edge_runtime_source_transaction_outcome "$transaction" rollback

# Exchange preparation rejects an existing target whose recorded source
# identity no longer matches its content.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
printf 'tampered prior\n' >> "$target/server.ts"
if supacloud_prepare_edge_runtime_source_exchange "$transaction" "$target"; then
    echo "Edge Runtime exchange accepted a tampered prior tree" >&2
    exit 1
fi
rm -rf -- "$transaction" "$transaction.cleanup" "$transaction.outcome"
reset_target_to_source_one

# A verified present prior tree must retain its identity evidence.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
supacloud_activate_edge_runtime_source "$transaction" "$target"
rm "$transaction/prior-identity"
if supacloud_rollback_edge_runtime_source "$transaction" "$target"; then
    echo "Edge Runtime rollback accepted a missing prior identity" >&2
    exit 1
fi
rm -rf -- "$transaction" "$transaction.cleanup" "$transaction.outcome"
reset_target_to_source_one

# Commit verifies the complete quarantined rollback tree, not only its source
# identity metadata.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
supacloud_activate_edge_runtime_source "$transaction" "$target"
printf 'tampered rollback payload\n' >> "$transaction/staged/server.ts"
if supacloud_commit_edge_runtime_source "$transaction" "$target"; then
    echo "Edge Runtime commit accepted a tampered rollback tree" >&2
    exit 1
fi
rm -rf -- "$transaction" "$transaction.cleanup" "$transaction.outcome"
reset_target_to_source_one

# Commit tombstones are resumable and cannot be mistaken for rollback work.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
supacloud_activate_edge_runtime_source "$transaction" "$target"
supacloud_write_edge_runtime_transaction_state "$transaction" commit-intent-present
supacloud_remove_edge_runtime_source_transaction "$transaction" commit "$target"
[[ ! -e "$transaction" && -d "${transaction}.cleanup" ]]
if supacloud_rollback_edge_runtime_source "$transaction" "$target"; then
    echo "Edge Runtime rollback accepted a committed tombstone" >&2
    exit 1
fi
supacloud_commit_edge_runtime_source "$transaction" "$target"
[[ ! -e "$transaction" && ! -e "${transaction}.cleanup" ]]
[[ "$(supacloud_edge_runtime_source_transaction_outcome "$transaction")" == commit ]]
supacloud_clear_edge_runtime_source_transaction_outcome "$transaction" commit
grep -Fq '1.2.4' "$target/server.ts"
transaction=$(supacloud_stage_edge_runtime_source "$source_one" "$target")
supacloud_activate_edge_runtime_source "$transaction" "$target"
supacloud_commit_edge_runtime_source "$transaction" "$target"
supacloud_clear_edge_runtime_source_transaction_outcome "$transaction" commit
grep -Fq '1.2.3' "$target/server.ts"

# Rollback tombstones are likewise resumable after a crash during quarantine.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
supacloud_activate_edge_runtime_source "$transaction" "$target"
supacloud_write_edge_runtime_transaction_state "$transaction" rollback-intent-present
supacloud_exchange_edge_runtime_directories "$target" "$transaction/staged"
supacloud_write_edge_runtime_transaction_state "$transaction" rolled-back-present
supacloud_remove_edge_runtime_source_transaction "$transaction" rollback "$target"
[[ ! -e "$transaction" && -d "${transaction}.cleanup" ]]
supacloud_rollback_edge_runtime_source "$transaction" "$target"
[[ ! -e "$transaction" && ! -e "${transaction}.cleanup" ]]
[[ "$(supacloud_edge_runtime_source_transaction_outcome "$transaction")" == rollback ]]
supacloud_clear_edge_runtime_source_transaction_outcome "$transaction" rollback
grep -Fq '1.2.3' "$target/server.ts"
supacloud_verify_edge_runtime_source_identity "$target" "$expected_version" "$expected_sha256"

# A crash after recording the durable exchange intent but before the atomic
# exchange can resume activation without losing either tree.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
supacloud_prepare_edge_runtime_source_exchange "$transaction" "$target"
[[ "$(<"$transaction/state")" == exchange-intent-present ]]
[[ "$(supacloud_edge_runtime_exchange_position "$transaction" "$target")" == $'present\tbefore' ]]
supacloud_activate_edge_runtime_source "$transaction" "$target"
[[ "$(<"$transaction/state")" == activated-present ]]
grep -Fq '1.2.4' "$target/server.ts"
supacloud_rollback_edge_runtime_source "$transaction" "$target"
grep -Fq '1.2.3' "$target/server.ts"

# A durable intent can be rolled back before the forward exchange starts.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
supacloud_prepare_edge_runtime_source_exchange "$transaction" "$target"
[[ "$(supacloud_edge_runtime_exchange_position "$transaction" "$target")" == $'present\tbefore' ]]
supacloud_rollback_edge_runtime_source "$transaction" "$target"
grep -Fq '1.2.3' "$target/server.ts"
supacloud_clear_edge_runtime_source_transaction_outcome "$transaction" rollback

# A crash after the atomic exchange but before the activated-state write is
# recovered from the recorded directory identities and rolls back safely.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
supacloud_prepare_edge_runtime_source_exchange "$transaction" "$target"
supacloud_exchange_edge_runtime_directories "$transaction/staged" "$target"
[[ "$(<"$transaction/state")" == exchange-intent-present ]]
[[ "$(supacloud_edge_runtime_exchange_position "$transaction" "$target")" == $'present\tafter' ]]
supacloud_rollback_edge_runtime_source "$transaction" "$target"
grep -Fq '1.2.3' "$target/server.ts"

# Resuming activation from the same post-exchange crash point records the
# activated state without performing a second exchange.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
supacloud_prepare_edge_runtime_source_exchange "$transaction" "$target"
supacloud_exchange_edge_runtime_directories "$transaction/staged" "$target"
supacloud_activate_edge_runtime_source "$transaction" "$target"
[[ "$(<"$transaction/state")" == activated-present ]]
grep -Fq '1.2.4' "$target/server.ts"

# Rollback is also resumable when the reverse exchange completed before its
# state update was made durable.
supacloud_write_edge_runtime_transaction_state "$transaction" rollback-intent-present
supacloud_exchange_edge_runtime_directories "$target" "$transaction/staged"
[[ "$(supacloud_edge_runtime_exchange_position "$transaction" "$target")" == $'present\tbefore' ]]
supacloud_rollback_edge_runtime_source "$transaction" "$target"
grep -Fq '1.2.3' "$target/server.ts"

absent_target="$tmp_dir/first-install"
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$absent_target")
supacloud_prepare_edge_runtime_source_exchange "$transaction" "$absent_target"
[[ "$(supacloud_edge_runtime_exchange_position "$transaction" "$absent_target")" == $'absent\tbefore' ]]
supacloud_rollback_edge_runtime_source "$transaction" "$absent_target"
[[ ! -e "$absent_target" ]]
supacloud_clear_edge_runtime_source_transaction_outcome "$transaction" rollback

transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$absent_target")
supacloud_activate_edge_runtime_source "$transaction" "$absent_target"
[[ -d "$absent_target" ]]
supacloud_rollback_edge_runtime_source "$transaction" "$absent_target"
[[ ! -e "$absent_target" ]]

# First-install recovery distinguishes a completed move from an unstarted one.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$absent_target")
supacloud_prepare_edge_runtime_source_exchange "$transaction" "$absent_target"
mv "$transaction/staged" "$absent_target"
[[ "$(supacloud_edge_runtime_exchange_position "$transaction" "$absent_target")" == $'absent\tafter' ]]
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

# Only the root identity file is metadata. A nested path with the same basename
# remains part of the source digest and cannot hide a payload change.
nested_source="$tmp_dir/nested-source"
make_source "$nested_source" "1.2.7"
mkdir -p "$nested_source/modules/.supacloud-source-identity.json"
printf 'nested payload\n' > "$nested_source/modules/.supacloud-source-identity.json/payload.ts"
supacloud_refresh_edge_runtime_source_identity "$nested_source" >/dev/null
nested_identity=$(supacloud_read_edge_runtime_source_identity "$nested_source")
printf 'nested tamper\n' >> "$nested_source/modules/.supacloud-source-identity.json/payload.ts"
if [[ "$(supacloud_read_edge_runtime_source_identity "$nested_source" 2>/dev/null || true)" == "$nested_identity" ]]; then
    echo "Nested identity-named payload was excluded from source digest" >&2
    exit 1
fi

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
supacloud_write_edge_runtime_transaction_identity \
    "$transaction" expected-identity "$refreshed_identity"
IFS=$'\t' read -r refreshed_version refreshed_sha256 <<< "$refreshed_identity"
supacloud_verify_edge_runtime_source_identity \
    "$transaction/staged" "$refreshed_version" "$refreshed_sha256"
supacloud_rollback_edge_runtime_source "$transaction" "$target"

transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
ln "$transaction/expected-identity" "$transaction/expected-identity.hardlink"
if supacloud_edge_runtime_transaction_identity "$transaction" >/dev/null 2>&1; then
    echo "Edge Runtime transaction accepted a hard-linked identity file" >&2
    exit 1
fi
rm "$transaction/expected-identity.hardlink"
supacloud_rollback_edge_runtime_source "$transaction" "$target"

transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
for temporary in .state.crash .expected-identity.crash .prior-identity.crash .exchange-intent.crash; do
    printf 'orphaned writer temp\n' > "$transaction/$temporary"
    chmod 0600 "$transaction/$temporary"
done
supacloud_edge_runtime_transaction_identity "$transaction" >/dev/null
for temporary in .state.crash .expected-identity.crash .prior-identity.crash .exchange-intent.crash; do
    [[ ! -e "$transaction/$temporary" ]]
done
ln -s /etc/passwd "$transaction/.state.unsafe"
if supacloud_edge_runtime_transaction_identity "$transaction" >/dev/null 2>&1; then
    echo "Edge Runtime transaction accepted an unsafe orphaned temporary file" >&2
    exit 1
fi
rm "$transaction/.state.unsafe"
supacloud_rollback_edge_runtime_source "$transaction" "$target"

# Missing state is never inferred from the remaining directory contents.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
rm "$transaction/state"
if supacloud_activate_edge_runtime_source "$transaction" "$target" >/dev/null 2>&1; then
    echo "Edge Runtime activation accepted a transaction without state" >&2
    exit 1
fi
if supacloud_rollback_edge_runtime_source "$transaction" "$target" >/dev/null 2>&1; then
    echo "Edge Runtime rollback accepted a transaction without state" >&2
    exit 1
fi
rm -rf -- "$transaction" "$transaction.cleanup" "$transaction.outcome"

# Safe orphaned outcome-writer files are removed durably; unsafe aliases fail
# closed before the transaction can be finalized.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
outcome_temporary="$(dirname "$transaction")/.$(basename "$transaction").outcome.crash"
printf 'orphaned outcome writer\n' > "$outcome_temporary"
chmod 0600 "$outcome_temporary"
supacloud_rollback_edge_runtime_source "$transaction" "$target"
[[ ! -e "$outcome_temporary" ]]
supacloud_clear_edge_runtime_source_transaction_outcome "$transaction" rollback

transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
outcome_temporary="$(dirname "$transaction")/.$(basename "$transaction").outcome.unsafe"
ln -s /etc/passwd "$outcome_temporary"
if supacloud_rollback_edge_runtime_source "$transaction" "$target" >/dev/null 2>&1; then
    echo "Edge Runtime rollback accepted an unsafe outcome temporary file" >&2
    exit 1
fi
rm "$outcome_temporary"
supacloud_rollback_edge_runtime_source "$transaction" "$target"
supacloud_clear_edge_runtime_source_transaction_outcome "$transaction" rollback

# A deployable staged tree is private, owned by the installer, and detached
# from hard-linked package-manager cache files.
transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
external_link="$tmp_dir/staged-server-hardlink"
ln "$transaction/staged/server.ts" "$external_link"
if supacloud_prepare_edge_runtime_source_exchange "$transaction" "$target" >/dev/null 2>&1; then
    echo "Edge Runtime exchange accepted a hard-linked staged file" >&2
    exit 1
fi
rm "$external_link"
supacloud_rollback_edge_runtime_source "$transaction" "$target"
supacloud_clear_edge_runtime_source_transaction_outcome "$transaction" rollback

transaction=$(supacloud_stage_edge_runtime_source "$source_two" "$target")
chmod 0666 "$transaction/staged/server.ts"
refreshed_identity=$(supacloud_refresh_edge_runtime_source_identity "$transaction/staged")
supacloud_write_edge_runtime_transaction_identity \
    "$transaction" expected-identity "$refreshed_identity"
if supacloud_prepare_edge_runtime_source_exchange "$transaction" "$target" >/dev/null 2>&1; then
    echo "Edge Runtime exchange accepted a group/other-writable staged file" >&2
    exit 1
fi
rm -rf -- "$transaction" "$transaction.cleanup" "$transaction.outcome"

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

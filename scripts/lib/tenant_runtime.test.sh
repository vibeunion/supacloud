#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_SCRIPT="${SCRIPT_DIR}/tenant_runtime.sh"

grep -Eq '^umask 077$' "$RUNTIME_SCRIPT"
grep -Fq 'PGPASSWORD="$db_password" psql' "$RUNTIME_SCRIPT"
grep -Fq 'v14.13' "$RUNTIME_SCRIPT"
grep -Fq '2a0537411cd79c7180f8669a6488d5813b89f93fa7e486915512aca96f1a9bcf' "$RUNTIME_SCRIPT"
grep -Fq 'd100eec50ec02f3811679847b2c90d08e178b2123c1f079eadddb8a920bcde2a' "$RUNTIME_SCRIPT"
grep -Fq 'v2.191.0' "$RUNTIME_SCRIPT"
grep -Fq '32da8473b79de594ea4c2b6023f3d34901b99e846dc1fce71dfd8fd3a65e0b72' "$RUNTIME_SCRIPT"
grep -Fq 'f24d79edc35ec33b78f1c9ee02909a002a2ac49ac071a82b51fb80eae1bdfb42' "$RUNTIME_SCRIPT"

if grep -Fq 'gh-proxy.net' "$RUNTIME_SCRIPT"; then
    echo "tenant_runtime.sh must not default to a third-party GitHub proxy" >&2
    exit 1
fi

line_number() {
    grep -nF "$1" "$RUNTIME_SCRIPT" | head -n 1 | cut -d: -f1
}

assert_order() {
    local create_line chown_line chmod_line
    create_line=$(line_number "$1")
    chown_line=$(line_number "$2")
    chmod_line=$(line_number "$3")
    if [[ -z "$create_line" || -z "$chown_line" || -z "$chmod_line" ||
          "$create_line" -ge "$chown_line" || "$chown_line" -ge "$chmod_line" ]]; then
        echo "unsafe tenant config ownership/mode order: $1" >&2
        exit 1
    fi
}

[[ $(grep -Ec '^User=supacloud-%i$' "$RUNTIME_SCRIPT") -eq 2 ]]
[[ $(grep -Ec '^Group=supacloud-%i$' "$RUNTIME_SCRIPT") -eq 2 ]]

if grep -Eq 'psql[[:space:]]+"postgres(ql)?://[^\"]*\$\{?db_password' "$RUNTIME_SCRIPT"; then
    echo "tenant_runtime.sh exposes the tenant database password in psql argv" >&2
    exit 1
fi

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

# shellcheck source=tenant_runtime.sh
source "$RUNTIME_SCRIPT"

special=$'p@:/#?% space \'"\\'
encoded_special='p%40%3A%2F%23%3F%25%20space%20%27%22%5C'
[[ "$(uri_percent_encode "$special")" == "$encoded_special" ]]
[[ "$(systemd_env_quote 'a b')" == '"a b"' ]]
[[ "$(systemd_env_quote 'a"b')" == '"a\"b"' ]]
[[ "$(systemd_env_quote 'a\b')" == '"a\\b"' ]]
[[ "$(toml_basic_string 'a"b\c')" == '"a\"b\\c"' ]]

for serializer in uri_percent_encode systemd_env_quote toml_basic_string; do
    if "$serializer" $'safe\nINJECTED=value' >/dev/null 2>&1; then
        echo "$serializer accepted an LF config injection" >&2
        exit 1
    fi
    if "$serializer" $'safe\rINJECTED=value' >/dev/null 2>&1; then
        echo "$serializer accepted a CR config injection" >&2
        exit 1
    fi
done

# Database text is assigned without command-substitution trimming, so a trailing
# or embedded newline reaches the fail-closed serializer instead of being lost.
PGPASSWORD="meta-password"
psql() { printf '736166650a494e4a45435445443d76616c7565\n'; }
retrieved_secret=""
get_tenant_credentials "abc123" "jwt_secret" retrieved_secret
[[ "$retrieved_secret" == $'safe\nINJECTED=value' ]]
if assert_safe_config_value "retrieved secret" "$retrieved_secret" >/dev/null 2>&1; then
    echo "newline-bearing database credential was accepted" >&2
    exit 1
fi
psql() { printf '610062\n'; }
if get_tenant_credentials "abc123" "jwt_secret" retrieved_secret >/dev/null 2>&1; then
    echo "NUL-bearing database credential was accepted" >&2
    exit 1
fi
unset -f psql

# Official GitHub is attempted first. A proxy is only an explicit fallback.
download_log="$tmp_dir/download.log"
curl() {
    local arg
    for arg in "$@"; do
        case "$arg" in https://*) printf '%s\n' "$arg" >> "$download_log" ;; esac
    done
    return 1
}
unset SUPACLOUD_GITHUB_PROXY
if download_release_asset "https://github.com/example/release.tar.xz" "$tmp_dir/no-proxy.tar.xz"; then
    echo "failed curl unexpectedly succeeded" >&2
    exit 1
fi
[[ $(wc -l < "$download_log" | tr -d ' ') == "1" ]]
[[ $(sed -n '1p' "$download_log") == "https://github.com/example/release.tar.xz" ]]

: > "$download_log"
export SUPACLOUD_GITHUB_PROXY="https://proxy.example.invalid"
if download_release_asset "https://github.com/example/release.tar.xz" "$tmp_dir/proxy.tar.xz"; then
    echo "failed curl unexpectedly succeeded" >&2
    exit 1
fi
[[ $(sed -n '1p' "$download_log") == "https://github.com/example/release.tar.xz" ]]
[[ $(sed -n '2p' "$download_log") == "https://proxy.example.invalid/https://github.com/example/release.tar.xz" ]]
unset -f curl
unset SUPACLOUD_GITHUB_PROXY

if resolve_release_sha256 "PostgREST" "v99.0.0" "v14.13" "default-digest" "" >/dev/null 2>&1; then
    echo "non-default PostgREST version reused the default digest" >&2
    exit 1
fi
explicit_digest=$(printf 'e%.0s' {1..64})
[[ "$(resolve_release_sha256 "PostgREST" "v99.0.0" "v14.13" "$(printf 'd%.0s' {1..64})" "$explicit_digest")" == "$explicit_digest" ]]

# Archive validation rejects digest mismatches and link/special-file payloads.
mkdir -p "$tmp_dir/archive/valid" "$tmp_dir/archive/link"
printf 'fake-elf' > "$tmp_dir/archive/valid/postgrest"
ln -s /bin/sh "$tmp_dir/archive/link/postgrest"
tar -cf "$tmp_dir/valid.tar.xz" -C "$tmp_dir/archive/valid" postgrest
tar -cf "$tmp_dir/link.tar.xz" -C "$tmp_dir/archive/link" postgrest
valid_sha=$(sha256_file "$tmp_dir/valid.tar.xz")
link_sha=$(sha256_file "$tmp_dir/link.tar.xz")
validate_elf_binary_definition=$(declare -f validate_elf_binary)
smoke_check_binary_definition=$(declare -f smoke_check_binary)
validate_elf_binary() { :; }
smoke_check_binary() { :; }
mkdir -p "$tmp_dir/bin"
install_verified_tar_binary "$tmp_dir/valid.tar.xz" "$valid_sha" "$tmp_dir/bin/postgrest" "x86_64" postgrest
[[ $(cat "$tmp_dir/bin/postgrest") == "fake-elf" ]]
if install_verified_tar_binary "$tmp_dir/valid.tar.xz" "$(printf '0%.0s' {1..64})" "$tmp_dir/bin/wrong-digest" "x86_64" postgrest >/dev/null 2>&1; then
    echo "digest mismatch was accepted" >&2
    exit 1
fi
[[ ! -e "$tmp_dir/bin/wrong-digest" ]]
if install_verified_tar_binary "$tmp_dir/link.tar.xz" "$link_sha" "$tmp_dir/bin/link-payload" "x86_64" postgrest >/dev/null 2>&1; then
    echo "link payload was accepted" >&2
    exit 1
fi
[[ ! -e "$tmp_dir/bin/link-payload" ]]
unset -f validate_elf_binary smoke_check_binary
eval "$validate_elf_binary_definition"
eval "$smoke_check_binary_definition"
file() { printf 'ELF 64-bit LSB executable, x86-64, version 1 (SYSV)\n'; }
validate_elf_binary "$tmp_dir/bin/postgrest" "x86_64"
if validate_elf_binary "$tmp_dir/bin/postgrest" "aarch64" >/dev/null 2>&1; then
    echo "wrong ELF architecture was accepted" >&2
    exit 1
fi
unset -f file
grep -Fq 'install -m 0755 "${work_dir}/binary" "$install_tmp"' "$RUNTIME_SCRIPT"
grep -Fq 'mv -f "$install_tmp" "$target_path"' "$RUNTIME_SCRIPT"

(
    export TENANT_CONFIG_DIR="$tmp_dir/tenants"
    export PGPASSWORD="$special"
    export GOTRUE_SMTP_HOST="smtp.example.com"
    export GOTRUE_SMTP_USER="$special"
    export GOTRUE_SMTP_PASS="$special"

    ensure_tenant_runtime_user() { printf 'tenant-test'; }
    get_tenant_credentials() {
        local result
        case "$2" in
            db_password|jwt_secret) result="$special" ;;
            api_url) result='https://abc123.api.example.com' ;;
            *) return 1 ;;
        esac
        printf -v "$3" '%s' "$result"
    }
    psql() { printf '0\n'; }
    chown() { printf '%s\n' "$*" >> "$tmp_dir/chown.log"; }

    generate_tenant_config "abc123" 3101 4101 >/dev/null
)

grep -Fqx "PGRST_DB_URI=\"postgres://authenticator_abc123:${encoded_special}@localhost:6432/supa_abc123\"" "$tmp_dir/tenants/abc123.env"
grep -Fqx "db-uri = \"postgres://authenticator_abc123:${encoded_special}@localhost:6432/supa_abc123\"" "$tmp_dir/tenants/abc123.conf"
grep -Fqx "GOTRUE_DB_DATABASE_URL=\"postgres://supabase_auth_admin:${encoded_special}@localhost:6432/supa_abc123\"" "$tmp_dir/tenants/abc123_gotrue.env"
grep -Fq 'PGRST_JWT_SECRET="p@:/#?% space '\''\"\\"' "$tmp_dir/tenants/abc123.env"
grep -Fq 'GOTRUE_SMTP_USER="p@:/#?% space '\''\"\\"' "$tmp_dir/tenants/abc123_gotrue.env"
grep -Fqx 'GOTRUE_SMTP_SENDER_NAME="SupaCloud"' "$tmp_dir/tenants/abc123_gotrue.env"

# Reject injected assignments before any tenant config is written.
if (
    export TENANT_CONFIG_DIR="$tmp_dir/injected-tenants"
    export PGPASSWORD="meta-password"
    ensure_tenant_runtime_user() { printf 'tenant-test'; }
    get_tenant_credentials() {
        local result
        case "$2" in
            db_password) result='tenant-db-password' ;;
            jwt_secret) result=$'safe\nINJECTED=value' ;;
            api_url) result='https://inject.api.example.com' ;;
            *) return 1 ;;
        esac
        printf -v "$3" '%s' "$result"
    }
    psql() { printf '0\n'; }
    chown() { :; }
    generate_tenant_config "inject" 3102 4102 >/dev/null 2>&1
); then
    echo "tenant config accepted an injected assignment" >&2
    exit 1
fi
[[ ! -e "$tmp_dir/injected-tenants/inject.env" ]]

file_mode() {
    if stat -f '%Lp' "$1" >/dev/null 2>&1; then
        stat -f '%Lp' "$1"
    else
        stat -c '%a' "$1"
    fi
}

for secret_file in \
    "$tmp_dir/tenants/abc123.env" \
    "$tmp_dir/tenants/abc123.conf" \
    "$tmp_dir/tenants/abc123_gotrue.env" \
    "$tmp_dir/tenants/abc123_gotrue.d/runtime.env"; do
    [[ $(file_mode "$secret_file") == "600" ]]
done
[[ $(file_mode "$tmp_dir/tenants/abc123_gotrue.d") == "700" ]]
for owned_path in \
    "$tmp_dir/tenants/abc123.env" \
    "$tmp_dir/tenants/abc123.conf" \
    "$tmp_dir/tenants/abc123_gotrue.env" \
    "$tmp_dir/tenants/abc123_gotrue.d"; do
    grep -Fq "tenant-test:tenant-test $owned_path" "$tmp_dir/chown.log"
done

echo "tenant runtime security checks passed"

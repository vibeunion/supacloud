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
    systemctl() {
        if [ "$1" = is-active ] && [ "$2" = supacloud.service ]; then return 3; fi
        return 0
    }

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
    systemctl() {
        if [ "$1" = is-active ] && [ "$2" = supacloud.service ]; then return 3; fi
        return 0
    }
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

# Shared-auth tenants start only PostgREST and never download or start a local GoTrue.
shared_runtime_log="$tmp_dir/shared-runtime.log"
shared_runtime_output=$(
    export TENANT_CONFIG_DIR="$tmp_dir/shared-tenants"
    mkdir -p "$TENANT_CONFIG_DIR"
    touch "$(shared_auth_marker_path shared123)"
    ensure_postgrest() { printf 'ensure-postgrest\n' >> "$shared_runtime_log"; }
    ensure_gotrue() { printf 'ensure-gotrue\n' >> "$shared_runtime_log"; return 1; }
    install_systemd_template() { printf 'install-template\n' >> "$shared_runtime_log"; }
    generate_tenant_config() { printf 'generate-config\n' >> "$shared_runtime_log"; }
    get_tenant_port() { [ "$2" = pgrst ] && printf '3101' || printf '4101'; }
    systemctl() {
        if [ "$1" = is-active ] || [ "$1" = is-enabled ]; then return 1; fi
        printf '%s\n' "$*" >> "$shared_runtime_log"
    }
    curl() { return 0; }
    start_runtime shared123
)
grep -Fq 'Waiting for PostgREST(3101) with shared authentication boundary...' <<< "$shared_runtime_output"
grep -Fq 'GOTRUE_MODE=shared' <<< "$shared_runtime_output"
grep -Fq 'stop supacloud-gotrue@shared123' "$shared_runtime_log"
grep -Fq 'disable supacloud-gotrue@shared123' "$shared_runtime_log"
if grep -Fq 'ensure-gotrue' "$shared_runtime_log" \
    || grep -Fq 'start supacloud-gotrue@shared123' "$shared_runtime_log" \
    || grep -Fq 'enable supacloud-gotrue@shared123' "$shared_runtime_log"; then
    echo "shared-auth runtime attempted to prepare or start local GoTrue" >&2
    exit 1
fi

# Management API markers protect all PostgREST and GoTrue files from legacy regeneration.
managed_dir="$tmp_dir/managed-tenants"
mkdir -p "$managed_dir/managed123_gotrue.d"
printf '# Managed by SupaCloud Management API.\nMANAGED_SENTINEL=pgrst-env\n' > "$managed_dir/managed123.env"
printf '# Managed by SupaCloud Management API.\nMANAGED_SENTINEL=pgrst-conf\n' > "$managed_dir/managed123.conf"
printf '# Managed by SupaCloud Management API.\nMANAGED_SENTINEL=outer\n' > "$managed_dir/managed123_gotrue.env"
printf '# Managed by SupaCloud Management API.\nMANAGED_SENTINEL=runtime\n' > "$managed_dir/managed123_gotrue.d/runtime.env"
managed_pgrst_env_before=$(sha256_file "$managed_dir/managed123.env")
managed_pgrst_conf_before=$(sha256_file "$managed_dir/managed123.conf")
managed_outer_before=$(sha256_file "$managed_dir/managed123_gotrue.env")
managed_runtime_before=$(sha256_file "$managed_dir/managed123_gotrue.d/runtime.env")
(
    export TENANT_CONFIG_DIR="$managed_dir"
    ensure_tenant_runtime_user() { printf 'tenant-test'; }
    get_tenant_credentials() { echo "managed config unexpectedly queried credentials" >&2; return 1; }
    generate_tenant_config managed123 3103 4103 >/dev/null
)
[[ "$(sha256_file "$managed_dir/managed123.env")" == "$managed_pgrst_env_before" ]]
[[ "$(sha256_file "$managed_dir/managed123.conf")" == "$managed_pgrst_conf_before" ]]
[[ "$(sha256_file "$managed_dir/managed123_gotrue.env")" == "$managed_outer_before" ]]
[[ "$(sha256_file "$managed_dir/managed123_gotrue.d/runtime.env")" == "$managed_runtime_before" ]]

# A shared marker preserves owner/JWKS PostgREST config and makes stop/disable failures fatal.
shared_managed_dir="$tmp_dir/shared-managed-tenants"
shared_managed_log="$tmp_dir/shared-managed-systemctl.log"
mkdir -p "$shared_managed_dir"
printf '# Managed by SupaCloud Management API.\nJWT_SENTINEL=owner-jwks\n' > "$shared_managed_dir/shared456.env"
printf '# Managed by SupaCloud Management API.\njwt-secret = "owner-jwks"\n' > "$shared_managed_dir/shared456.conf"
printf 'owner123\n' > "$shared_managed_dir/shared456_gotrue.shared"
shared_env_before=$(sha256_file "$shared_managed_dir/shared456.env")
shared_conf_before=$(sha256_file "$shared_managed_dir/shared456.conf")
(
    export TENANT_CONFIG_DIR="$shared_managed_dir"
    ensure_tenant_runtime_user() { printf 'tenant-test'; }
    get_tenant_credentials() { echo "shared config unexpectedly queried local credentials" >&2; return 1; }
    systemctl() { printf '%s\n' "$*" >> "$shared_managed_log"; }
    generate_tenant_config shared456 3104 4104 >/dev/null
)
[[ "$(sha256_file "$shared_managed_dir/shared456.env")" == "$shared_env_before" ]]
[[ "$(sha256_file "$shared_managed_dir/shared456.conf")" == "$shared_conf_before" ]]
grep -Fq 'stop supacloud-gotrue@shared456' "$shared_managed_log"
grep -Fq 'disable supacloud-gotrue@shared456' "$shared_managed_log"

if (
    export TENANT_CONFIG_DIR="$shared_managed_dir"
    ensure_tenant_runtime_user() { printf 'tenant-test'; }
    systemctl() { return 1; }
    generate_tenant_config shared456 3104 4104 >/dev/null 2>&1
); then
    echo "shared GoTrue stop/disable failure was ignored" >&2
    exit 1
fi

# Environment-only shared detection cannot invent verifier config; a marker is required.
mkdir -p "$tmp_dir/unmarked-shared/shared789_gotrue.d"
printf '# Managed by SupaCloud Management API.\nLOCAL_SENTINEL=pgrst-env\n' > "$tmp_dir/unmarked-shared/shared789.env"
printf '# Managed by SupaCloud Management API.\njwt-secret = "dependent-local-secret"\n' > "$tmp_dir/unmarked-shared/shared789.conf"
printf '# Managed by SupaCloud Management API.\nLOCAL_SENTINEL=gotrue\n' > "$tmp_dir/unmarked-shared/shared789_gotrue.env"
printf '# Managed by SupaCloud Management API.\nLOCAL_SENTINEL=runtime\n' > "$tmp_dir/unmarked-shared/shared789_gotrue.d/runtime.env"
if (
    export TENANT_CONFIG_DIR="$tmp_dir/unmarked-shared"
    export SUPACLOUD_AUTH_RUNTIME_OWNER_REF="owner123"
    ensure_tenant_runtime_user() { printf 'tenant-test'; }
    get_tenant_credentials() { echo "unmarked shared config queried credentials" >&2; return 1; }
    generate_tenant_config shared789 3105 4105 >/dev/null 2>&1
); then
    echo "unmarked shared runtime was regenerated by legacy shell" >&2
    exit 1
fi
grep -Fq 'dependent-local-secret' "$tmp_dir/unmarked-shared/shared789.conf"

# Unknown systemctl/control-plane state is not equivalent to an inactive owner.
if (
    export TENANT_CONFIG_DIR="$tmp_dir/unknown-control-plane"
    unset SUPACLOUD_AUTH_RUNTIME_OWNER_REF
    ensure_tenant_runtime_user() { printf 'tenant-test'; }
    systemctl() { return 1; }
    get_tenant_credentials() { echo "unknown control plane queried credentials" >&2; return 1; }
    generate_tenant_config uncertain123 3106 4106 >/dev/null 2>&1
); then
    echo "unknown control-plane state allowed legacy regeneration" >&2
    exit 1
fi
[[ ! -e "$tmp_dir/unknown-control-plane/uncertain123.conf" ]]

# A missing systemctl binary is also unknown, so stop cleanup must fail closed.
mkdir -p "$tmp_dir/no-systemctl-path"
if ! (
    export PATH="$tmp_dir/no-systemctl-path"
    export TENANT_CONFIG_DIR="$tmp_dir/no-systemctl-tenants"
    should_preserve_runtime_config_on_stop nosystemctl
); then
    echo "missing systemctl was treated as a known-inactive Management API" >&2
    exit 1
fi

# Stopping a Management API managed runtime must preserve its restartable config and runtime user.
managed_stop_dir="$tmp_dir/managed-stop"
managed_stop_log="$tmp_dir/managed-stop.log"
mkdir -p "$managed_stop_dir/managedstop_gotrue.d"
for managed_stop_file in \
    "$managed_stop_dir/managedstop.env" \
    "$managed_stop_dir/managedstop.conf" \
    "$managed_stop_dir/managedstop_gotrue.env" \
    "$managed_stop_dir/managedstop_gotrue.d/runtime.env"; do
    printf '# Managed by SupaCloud Management API.\nPRESERVE=true\n' > "$managed_stop_file"
done
(
    export TENANT_CONFIG_DIR="$managed_stop_dir"
    systemctl() { printf 'systemctl %s\n' "$*" >> "$managed_stop_log"; }
    userdel() { printf 'userdel %s\n' "$*" >> "$managed_stop_log"; }
    stop_runtime managedstop >/dev/null
)
for managed_stop_file in \
    "$managed_stop_dir/managedstop.env" \
    "$managed_stop_dir/managedstop.conf" \
    "$managed_stop_dir/managedstop_gotrue.env" \
    "$managed_stop_dir/managedstop_gotrue.d/runtime.env"; do
    [[ -f "$managed_stop_file" ]]
done
if grep -Fq 'userdel ' "$managed_stop_log"; then
    echo "managed runtime stop deleted the runtime user" >&2
    exit 1
fi

# Shared owner/JWKS config and its marker survive the same legacy stop path.
shared_stop_dir="$tmp_dir/shared-stop"
shared_stop_log="$tmp_dir/shared-stop.log"
mkdir -p "$shared_stop_dir"
printf '# Managed by SupaCloud Management API.\nJWT_SENTINEL=owner-jwks\n' > "$shared_stop_dir/sharedstop.env"
printf '# Managed by SupaCloud Management API.\njwt-secret = "owner-jwks"\n' > "$shared_stop_dir/sharedstop.conf"
printf 'owner123\n' > "$shared_stop_dir/sharedstop_gotrue.shared"
(
    export TENANT_CONFIG_DIR="$shared_stop_dir"
    systemctl() { printf 'systemctl %s\n' "$*" >> "$shared_stop_log"; }
    userdel() { printf 'userdel %s\n' "$*" >> "$shared_stop_log"; }
    stop_runtime sharedstop >/dev/null
)
grep -Fq 'owner-jwks' "$shared_stop_dir/sharedstop.conf"
[[ -f "$shared_stop_dir/sharedstop_gotrue.shared" ]]
if grep -Fq 'userdel ' "$shared_stop_log"; then
    echo "shared runtime stop deleted the runtime user" >&2
    exit 1
fi

# Legacy-owned config is still removed when the Management API is known inactive.
legacy_stop_dir="$tmp_dir/legacy-stop"
legacy_stop_log="$tmp_dir/legacy-stop.log"
mkdir -p "$legacy_stop_dir/legacystop_gotrue.d"
printf 'LEGACY=true\n' > "$legacy_stop_dir/legacystop.env"
printf 'legacy=true\n' > "$legacy_stop_dir/legacystop.conf"
printf 'LEGACY=true\n' > "$legacy_stop_dir/legacystop_gotrue.env"
printf 'LEGACY=true\n' > "$legacy_stop_dir/legacystop_gotrue.d/runtime.env"
(
    export TENANT_CONFIG_DIR="$legacy_stop_dir"
    systemctl() {
        if [ "$1" = is-active ] && [ "$2" = supacloud.service ]; then return 3; fi
        printf 'systemctl %s\n' "$*" >> "$legacy_stop_log"
    }
    userdel() { printf 'userdel %s\n' "$*" >> "$legacy_stop_log"; }
    stop_runtime legacystop >/dev/null
)
[[ ! -e "$legacy_stop_dir/legacystop.env" ]]
[[ ! -e "$legacy_stop_dir/legacystop.conf" ]]
[[ ! -e "$legacy_stop_dir/legacystop_gotrue.env" ]]
[[ ! -e "$legacy_stop_dir/legacystop_gotrue.d" ]]
grep -Fq 'userdel supacloud-legacystop' "$legacy_stop_log"

echo "tenant runtime security checks passed"

#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deployment_profile.sh
source "${SCRIPT_DIR}/deployment_profile.sh"

assert_eq() {
    local expected="$1"
    local actual="$2"
    [[ "$actual" == "$expected" ]] || {
        printf 'expected %q, got %q\n' "$expected" "$actual" >&2
        exit 1
    }
}

unset SUPACLOUD_DEPLOYMENT_PROFILE SUPACLOUD_DATABASE_URL SUPACLOUD_USE_PIGSTY SUPACLOUD_DATABASE_PROVIDER PIGSTY_PATH
supacloud_resolve_deployment_profile
assert_eq podman "$SUPACLOUD_DEPLOYMENT_PROFILE"
assert_eq podman-single-node "$SUPACLOUD_DATABASE_PROVIDER"

SUPACLOUD_USE_PIGSTY=true
unset SUPACLOUD_DEPLOYMENT_PROFILE SUPACLOUD_DATABASE_URL SUPACLOUD_DATABASE_PROVIDER
supacloud_resolve_deployment_profile
assert_eq pigsty "$SUPACLOUD_DEPLOYMENT_PROFILE"
assert_eq pigsty "$SUPACLOUD_DATABASE_PROVIDER"

SUPACLOUD_DEPLOYMENT_PROFILE=solo
unset SUPACLOUD_DATABASE_URL SUPACLOUD_USE_PIGSTY SUPACLOUD_DATABASE_PROVIDER
supacloud_resolve_deployment_profile
assert_eq solo "$SUPACLOUD_DEPLOYMENT_PROFILE"
assert_eq podman-single-node "$SUPACLOUD_DATABASE_PROVIDER"

SUPACLOUD_DEPLOYMENT_PROFILE=external
SUPACLOUD_DATABASE_URL='postgresql://user:secret@db.example.test:5432/app'
unset SUPACLOUD_DATABASE_PROVIDER
supacloud_resolve_deployment_profile
assert_eq external "$SUPACLOUD_DEPLOYMENT_PROFILE"
assert_eq external-postgres "$SUPACLOUD_DATABASE_PROVIDER"

unset SUPACLOUD_DEPLOYMENT_PROFILE SUPACLOUD_DATABASE_URL SUPACLOUD_DATABASE_PROVIDER
SUPACLOUD_USE_PIGSTY=false
supacloud_resolve_deployment_profile
assert_eq podman "$SUPACLOUD_DEPLOYMENT_PROFILE"
assert_eq podman-single-node "$SUPACLOUD_DATABASE_PROVIDER"

if supacloud_require_pigsty_install_path >/dev/null 2>&1; then
    printf 'unwired solo provider was accepted by the legacy installer\n' >&2
    exit 1
fi

SUPACLOUD_DEPLOYMENT_PROFILE=podman
unset SUPACLOUD_DATABASE_URL SUPACLOUD_DATABASE_PROVIDER
supacloud_resolve_deployment_profile
assert_eq podman "$SUPACLOUD_DEPLOYMENT_PROFILE"
assert_eq podman-single-node "$SUPACLOUD_DATABASE_PROVIDER"
if supacloud_require_pigsty_install_path >/dev/null 2>&1; then
    printf 'unwired podman provider was accepted by the native installer\n' >&2
    exit 1
fi

SUPACLOUD_DEPLOYMENT_PROFILE=docker
if supacloud_resolve_deployment_profile >/dev/null 2>&1; then
    printf 'removed docker profile was accepted\n' >&2
    exit 1
fi

SUPACLOUD_DEPLOYMENT_PROFILE=cluster
unset SUPACLOUD_DATABASE_URL SUPACLOUD_DATABASE_PROVIDER
supacloud_resolve_deployment_profile
assert_eq cluster "$SUPACLOUD_DEPLOYMENT_PROFILE"
assert_eq cluster-external "$SUPACLOUD_DATABASE_PROVIDER"
if supacloud_require_pigsty_install_path >/dev/null 2>&1; then
    printf 'cluster profile was accepted by the native installer\n' >&2
    exit 1
fi

SUPACLOUD_DEPLOYMENT_PROFILE=external
SUPACLOUD_DATABASE_URL='mysql://user:secret@db.example.test/app'
if supacloud_resolve_deployment_profile >/dev/null 2>&1; then
    printf 'invalid external database URL was accepted\n' >&2
    exit 1
fi

SUPACLOUD_DEPLOYMENT_PROFILE=solo
SUPACLOUD_DATABASE_URL='postgresql://user:secret@db.example.test:5432/app'
if supacloud_resolve_deployment_profile >/dev/null 2>&1; then
    printf 'solo profile silently accepted an external URL\n' >&2
    exit 1
fi

printf 'deployment profile tests passed\n'

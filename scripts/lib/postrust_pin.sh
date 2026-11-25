#!/usr/bin/env bash

# Pinned inputs for Postrust v3.4.0.
# The upstream release stays v3.4.0. The official image is not installed.
# The host installer and tenant runtime default to the temporary layer below.
# POSTGREST_VERSION=v3.4.0 still builds the source archive with the null-RPC
# patch and rustc 1.98.1. The temporary-layer rebuild uses Rust 1.94.1.
# Docs: docs/postrust-v3.4.0-adoption.md

SUPACLOUD_POSTRUST_UPSTREAM_VERSION="v3.4.0"
SUPACLOUD_POSTRUST_SOURCE_URL="https://github.com/postrust/postrust/archive/refs/tags/v3.4.0.tar.gz"
SUPACLOUD_POSTRUST_SOURCE_SHA256="2c5de117fe288a18046776dfd0505d21845ba49b072d62bdab2c29ce3f2fe722"
SUPACLOUD_POSTRUST_PATCH_ID="postrust-v3.4.0-null-rpc-args"
SUPACLOUD_POSTRUST_PATCH_SHA256="b6fc50a592ede5071484e5e83a5ad1b59134724dcd2d91f71bf60b5b8bc983a6"
SUPACLOUD_POSTRUST_RUSTC_VERSION="1.98.1"
SUPACLOUD_POSTRUST_FEATURES="admin-ui,otel"
SUPACLOUD_POSTRUST_RUST_DIST_SHA256_X86_64="24ba1338a2d35c5a3247936546429e163fa674d726102af18bdf624582c57aea"
SUPACLOUD_POSTRUST_RUST_DIST_SHA256_AARCH64="f00ba576645cef658e1deed96fab8f707958e9d58808b16343448b5d1c4f7407"

# Published temporary layer. It carries the null-RPC fix and the GraphQL
# type-name fix. scripts/build_postrust_temporary_fixes.sh reproduces these
# digests with Rust 1.94.1. That toolchain is not SUPACLOUD_POSTRUST_RUSTC_VERSION.
SUPACLOUD_POSTRUST_TEMPORARY_VERSION="v3.4.0+supacloud.1"
SUPACLOUD_POSTRUST_TEMPORARY_RELEASE_TAG="postrust-v3.4.0-supacloud.1"
SUPACLOUD_POSTRUST_TEMPORARY_LAYER_URL="https://github.com/vibeunion/supacloud/releases/download/postrust-v3.4.0-supacloud.1/postrust-v3.4.0-supacloud.1-linux-amd64.tar.gz"
SUPACLOUD_POSTRUST_TEMPORARY_LAYER_SHA256="e9e721400159b4e2cce78a860b2989cb67b3eb3628a232a57a0bd8a0072be79e"
SUPACLOUD_POSTRUST_TEMPORARY_BINARY_SHA256="647e3f3d649f96adca20db8d8b774167d8b4129d186dfa76839e6ed8866c457e"

# Official v3.4.0 image. JSON null named RPC arguments bind as empty strings.
# The default build refuses a binary with this SHA256.
SUPACLOUD_POSTRUST_UNPATCHED_IMAGE="docker.io/postrust/postrust:v3.4.0"
SUPACLOUD_POSTRUST_UNPATCHED_INDEX_DIGEST="sha256:4de17b6c68403317a33c0a8ab78edb347e6b3131e9784c25b5c700554ac61809"
SUPACLOUD_POSTRUST_UNPATCHED_MANIFEST_AMD64="sha256:17ffc00f28a065bf228eaa74e6b823be0ae5813b4cf7b37a48f0067b9a464e2c"
SUPACLOUD_POSTRUST_UNPATCHED_LAYER_AMD64="sha256:a2139f3563c558457f2b660bb92514a2b00d4d549392511fd127cd9669b5ef32"
SUPACLOUD_POSTRUST_LAYER_MEMBER="usr/local/bin/postrust"
SUPACLOUD_POSTRUST_UNPATCHED_BINARY_SHA256="f174c84a1b3ac8a24c13a4ef7896adfc029ece8c1b206ee715e3864f5f169b7a"

# True when the binary beside this stamp is the patched default build.
supacloud_postrust_patch_stamp_matches() {
    local binary_path="$1"
    local stamp="${binary_path}.postrust-patch"
    local patch_id="" patch_sha="" source_sha="" rustc="" features="" actual=""
    [[ -f "$binary_path" && ! -L "$binary_path" && -f "$stamp" && ! -L "$stamp" ]] || return 1
    {
        IFS= read -r patch_id || return 1
        IFS= read -r patch_sha || return 1
        IFS= read -r source_sha || return 1
        IFS= read -r rustc || return 1
        IFS= read -r features || return 1
    } < "$stamp"
    [[ "$patch_id" == "$SUPACLOUD_POSTRUST_PATCH_ID" \
        && "$patch_sha" == "$SUPACLOUD_POSTRUST_PATCH_SHA256" \
        && "$source_sha" == "$SUPACLOUD_POSTRUST_SOURCE_SHA256" \
        && "$rustc" == "$SUPACLOUD_POSTRUST_RUSTC_VERSION" \
        && "$features" == "$SUPACLOUD_POSTRUST_FEATURES" ]] || return 1
    actual=$(sha256sum "$binary_path" | awk '{print $1}' | tr '[:upper:]' '[:lower:]') || return 1
    [[ "$actual" != "$SUPACLOUD_POSTRUST_UNPATCHED_BINARY_SHA256" ]]
}

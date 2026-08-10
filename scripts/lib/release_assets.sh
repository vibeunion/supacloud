#!/usr/bin/env bash

SUPACLOUD_GITHUB_REPOSITORY="${SUPACLOUD_GITHUB_REPOSITORY:-zuohuadong/supacloud}"
SUPACLOUD_RELEASES_API="${SUPACLOUD_RELEASES_API:-https://api.github.com/repos/${SUPACLOUD_GITHUB_REPOSITORY}/releases}"
SUPACLOUD_ATTESTATION_SIGNER_WORKFLOW="${SUPACLOUD_ATTESTATION_SIGNER_WORKFLOW:-${SUPACLOUD_GITHUB_REPOSITORY}/.github/workflows/release-please.yml}"
SUPACLOUD_GH_VERSION="${SUPACLOUD_GH_VERSION:-2.96.0}"
SUPACLOUD_GH_MIN_VERSION="${SUPACLOUD_GH_MIN_VERSION:-2.68.0}"
SUPACLOUD_GH_AMD64_SHA256="${SUPACLOUD_GH_AMD64_SHA256:-83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60}"
SUPACLOUD_GH_ARM64_SHA256="${SUPACLOUD_GH_ARM64_SHA256:-06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909}"

supacloud_curl_release_json() {
    local url="$1"
    local output="$2"
    curl -fsSL --proto '=https' --proto-redir '=https' \
        --retry 1 --retry-delay 2 --retry-max-time 60 \
        --connect-timeout 15 --max-time 30 --speed-limit 128 --speed-time 10 \
        -o "$output" "$url"
}

supacloud_curl_release_asset() {
    local url="$1"
    local output="$2"
    curl -fL --proto '=https' --proto-redir '=https' \
        --retry 1 --retry-delay 2 --retry-max-time 180 \
        --connect-timeout 15 --max-time 90 --speed-limit 128 --speed-time 60 \
        -o "$output" "$url"
}

supacloud_component_tag() {
    local component="$1"
    local version="$2"
    case "$version" in
        "${component}-v"*) printf '%s' "$version" ;;
        v*) printf '%s-%s' "$component" "$version" ;;
        *) printf '%s-v%s' "$component" "$version" ;;
    esac
}

supacloud_select_release() {
    local component="$1"
    shift
    local required_assets_json
    [[ $# -gt 0 ]] || {
        echo "at least one required release asset must be specified" >&2
        return 1
    }
    required_assets_json=$(printf '%s\n' "$@" | jq -Rsc 'split("\n")[:-1]')
    jq -ce --arg prefix "${component}-v" --argjson required "$required_assets_json" '
        map(select(
            (.draft | not)
            and (.prerelease | not)
            and (.tag_name | startswith($prefix))
            and (. as $release | all($required[]; . as $asset | any($release.assets[]?; .name == $asset)))
            and any(.assets[]?; .name == "SHA256SUMS")
        ))
        | first
        // error("no matching component release contains all required assets and SHA256SUMS")
    '
}

supacloud_fetch_component_release() {
    local component="$1"
    local version="${2:-latest}"
    shift 2
    local required_assets=("$@")
    local required_assets_json
    local response
    [[ ${#required_assets[@]} -gt 0 ]] || {
        echo "at least one required release asset must be specified" >&2
        return 1
    }
    required_assets_json=$(printf '%s\n' "${required_assets[@]}" | jq -Rsc 'split("\n")[:-1]')

    if [[ -n "$version" && "$version" != "latest" ]]; then
        local tag
        tag=$(supacloud_component_tag "$component" "$version")
        response=$(supacloud_fetch_release_json "${SUPACLOUD_RELEASES_API}/tags/${tag}") || return 1
        jq -ce --argjson required "$required_assets_json" '
            select(
                (.draft | not)
                and (.prerelease | not)
                and (. as $release | all($required[]; . as $asset | any($release.assets[]?; .name == $asset)))
                and any(.assets[]?; .name == "SHA256SUMS")
            )
            // error("release does not contain all required assets and SHA256SUMS")
        ' <<< "$response"
        return
    fi

    response=$(supacloud_fetch_release_json "${SUPACLOUD_RELEASES_API}?per_page=100") || return 1
    supacloud_select_release "$component" "${required_assets[@]}" <<< "$response"
}

supacloud_fetch_release_json() (
    local url="$1"
    local response_file
    response_file=$(mktemp) || return 1
    trap 'rm -f "$response_file"' EXIT
    trap 'trap - EXIT HUP INT TERM; rm -f "$response_file"; exit 1' HUP INT TERM
    supacloud_download_release_metadata_url "$url" "$response_file" || return 1
    cat "$response_file"
)

supacloud_release_asset_url() {
    local release_json="$1"
    local asset_name="$2"
    jq -er --arg asset "$asset_name" '
        first(.assets[]? | select(.name == $asset) | .browser_download_url)
        // error("release asset URL is missing")
    ' <<< "$release_json"
}

supacloud_download_url() {
    local url="$1"
    local output="$2"
    local proxy="${SUPACLOUD_GITHUB_PROXY:-${GH_PROXY:-}}"

    if supacloud_curl_release_asset "$url" "$output"; then
        return 0
    fi
    if [[ -n "$proxy" ]]; then
        supacloud_curl_release_asset "${proxy%/}/${url}" "$output"
        return
    fi
    return 1
}

supacloud_download_release_metadata_url() {
    local url="$1"
    local output="$2"
    local proxy="${SUPACLOUD_GITHUB_PROXY:-${GH_PROXY:-}}"

    if supacloud_curl_release_json "$url" "$output"; then
        return 0
    fi
    if [[ -n "$proxy" ]]; then
        supacloud_curl_release_json "${proxy%/}/${url}" "$output"
        return
    fi
    return 1
}

supacloud_verify_checksum() {
    local artifact_file="$1"
    local asset_name="$2"
    local checksum_file="$3"
    local expected
    expected=$(awk -v asset="$asset_name" '$2 == asset || $2 == "*" asset { print $1; exit }' "$checksum_file")
    if [[ ! "$expected" =~ ^[0-9a-fA-F]{64}$ ]]; then
        echo "SHA256SUMS does not contain a valid checksum for ${asset_name}" >&2
        return 1
    fi

    local actual
    actual=$(sha256sum "$artifact_file" | awk '{print $1}')
    actual=$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')
    expected=$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')
    if [[ "$actual" != "$expected" ]]; then
        echo "SHA256 mismatch for ${asset_name}" >&2
        return 1
    fi
}

supacloud_validate_binary() {
    local artifact_file="$1"
    local asset_name="$2"
    local description
    description=$(file -b "$artifact_file")
    if [[ "$description" != *ELF* ]]; then
        echo "${asset_name} is not an ELF binary: ${description}" >&2
        return 1
    fi

    case "$asset_name" in
        *amd64)
            [[ "$description" == *x86-64* || "$description" == *x86_64* ]] || {
                echo "${asset_name} does not contain an x86-64 ELF binary" >&2
                return 1
            }
            ;;
        *arm64)
            [[ "$description" == *aarch64* || "$description" == *ARM64* ]] || {
                echo "${asset_name} does not contain an arm64 ELF binary" >&2
                return 1
            }
            ;;
    esac
}

supacloud_install_pinned_tar_xz_binary() (
    local archive="$1"
    local member="$2"
    local expected_sha256="$3"
    local arch="$4"
    local target="$5"
    local actual_sha256 member_count member_details extract_dir candidate staged_target

    actual_sha256=$(sha256sum "$archive" | awk '{print $1}')
    actual_sha256=$(printf '%s' "$actual_sha256" | tr '[:upper:]' '[:lower:]')
    expected_sha256=$(printf '%s' "$expected_sha256" | tr '[:upper:]' '[:lower:]')
    if [[ ! "$expected_sha256" =~ ^[0-9a-f]{64}$ || "$actual_sha256" != "$expected_sha256" ]]; then
        echo "SHA256 mismatch for pinned archive" >&2
        return 1
    fi

    member_count=$(tar -tJf "$archive" | grep -Fxc "$member" || true)
    if [[ "$member_count" != "1" ]]; then
        echo "Pinned archive must contain the exact member once: $member" >&2
        return 1
    fi
    member_details=$(tar -tvJf "$archive" "$member") || return 1
    if [[ "${member_details:0:1}" != "-" ]]; then
        echo "Pinned archive member is not a regular file: $member" >&2
        return 1
    fi

    extract_dir=$(mktemp -d)
    trap 'rm -rf "$extract_dir"; [[ -z "${staged_target:-}" ]] || rm -f "$staged_target"' EXIT
    trap 'trap - EXIT HUP INT TERM; rm -rf "$extract_dir"; [[ -z "${staged_target:-}" ]] || rm -f "$staged_target"; exit 1' HUP INT TERM
    if ! tar --no-same-owner --no-same-permissions -xJf "$archive" -C "$extract_dir" "$member"; then
        return 1
    fi
    candidate="${extract_dir}/${member}"
    supacloud_validate_binary "$candidate" "pinned-linux-${arch}" || return 1

    mkdir -p "$(dirname "$target")"
    staged_target=$(mktemp "${target}.tmp.XXXXXX")
    install -m 0755 "$candidate" "$staged_target"
    mv -f "$staged_target" "$target"
    staged_target=""
)

supacloud_version_at_least() {
    local current="${1#v}"
    local required="${2#v}"
    local current_major=0 current_minor=0 current_patch=0
    local required_major=0 required_minor=0 required_patch=0
    [[ "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-.*)?$ ]] || return 1
    [[ "$required" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-.*)?$ ]] || return 1
    IFS=. read -r current_major current_minor current_patch <<EOF
${current%%-*}
EOF
    IFS=. read -r required_major required_minor required_patch <<EOF
${required%%-*}
EOF
    current_major=${current_major:-0}; current_minor=${current_minor:-0}; current_patch=${current_patch:-0}
    required_major=${required_major:-0}; required_minor=${required_minor:-0}; required_patch=${required_patch:-0}
    if (( current_major != required_major )); then (( current_major > required_major )); return; fi
    if (( current_minor != required_minor )); then (( current_minor > required_minor )); return; fi
    (( current_patch >= required_patch ))
}

supacloud_gh_version() {
    gh --version 2>/dev/null | awk 'NR == 1 && $1 == "gh" && $2 == "version" { print $3; exit }'
}

supacloud_install_gh_archive() {
    local archive="$1"
    local version="$2"
    local arch="$3"
    local expected_sha256="$4"
    local target="$5"
    local member="gh_${version}_linux_${arch}/bin/gh"
    local actual_sha256 member_count member_details extracted_dir candidate version_output

    actual_sha256=$(sha256sum "$archive" | awk '{print $1}')
    if [[ "$actual_sha256" != "$expected_sha256" ]]; then
        echo "GitHub CLI archive SHA256 mismatch" >&2
        return 1
    fi

    member_count=$(tar -tzf "$archive" | grep -Fxc "$member" || true)
    if [[ "$member_count" != "1" ]]; then
        echo "GitHub CLI archive does not contain the exact expected member: $member" >&2
        return 1
    fi
    member_details=$(tar -tvzf "$archive" "$member") || return 1
    if [[ "${member_details:0:1}" != "-" ]]; then
        echo "GitHub CLI archive member is not a regular file: $member" >&2
        return 1
    fi

    extracted_dir=$(mktemp -d)
    candidate="${extracted_dir}/${member}"
    if ! tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$extracted_dir" "$member" \
        || ! supacloud_validate_binary "$candidate" "gh-linux-${arch}"; then
        rm -rf "$extracted_dir"
        return 1
    fi
    chmod 0755 "$candidate"
    version_output=$("$candidate" --version 2>/dev/null | head -1) || {
        rm -rf "$extracted_dir"
        echo "GitHub CLI bootstrap binary failed its version check" >&2
        return 1
    }
    if [[ "$version_output" != "gh version ${version}"* ]]; then
        rm -rf "$extracted_dir"
        echo "GitHub CLI bootstrap version mismatch: ${version_output}" >&2
        return 1
    fi
    mkdir -p "$(dirname "$target")"
    install -m 0755 "$candidate" "$target"
    rm -rf "$extracted_dir"
}

supacloud_install_pinned_gh() {
    local target="${1:-/usr/local/bin/gh}"
    local machine arch expected_sha256 asset url archive
    machine=$(uname -m)
    case "$machine" in
        x86_64|amd64)
            arch="amd64"
            expected_sha256="$SUPACLOUD_GH_AMD64_SHA256"
            ;;
        aarch64|arm64)
            arch="arm64"
            expected_sha256="$SUPACLOUD_GH_ARM64_SHA256"
            ;;
        *)
            echo "Unsupported architecture for GitHub CLI bootstrap: $machine" >&2
            return 1
            ;;
    esac
    asset="gh_${SUPACLOUD_GH_VERSION}_linux_${arch}.tar.gz"
    url="https://github.com/cli/cli/releases/download/v${SUPACLOUD_GH_VERSION}/${asset}"
    archive=$(mktemp)
    if ! supacloud_download_url "$url" "$archive" \
        || ! supacloud_install_gh_archive "$archive" "$SUPACLOUD_GH_VERSION" "$arch" "$expected_sha256" "$target"; then
        rm -f "$archive"
        return 1
    fi
    rm -f "$archive"
}

supacloud_validate_tar() {
    local artifact_file="$1"
    local entries
    entries=$(tar -tzf "$artifact_file") || {
        echo "Web Console archive is not a readable gzip tarball" >&2
        return 1
    }
    if ! printf '%s\n' "$entries" | awk '
        /^\// { exit 1 }
        /(^|\/)\.\.($|\/)/ { exit 1 }
    '; then
        echo "Web Console archive contains an unsafe path" >&2
        return 1
    fi
    if ! tar -tvzf "$artifact_file" | awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }'; then
        echo "Web Console archive contains links or special files" >&2
        return 1
    fi
    printf '%s\n' "$entries" | grep -Eq '(^|/)index\.html$' || {
        echo "Web Console archive is invalid or does not contain index.html" >&2
        return 1
    }
}

supacloud_record_integrity_mode() {
    local mode="$1"
    local record_file="${SUPACLOUD_INTEGRITY_MODE_RECORD:-/var/lib/supacloud/artifact-integrity-mode}"
    mkdir -p "$(dirname "$record_file")" 2>/dev/null || return 0
    printf '%s\n' "$mode" > "$record_file" 2>/dev/null || return 0
    chmod 600 "$record_file" 2>/dev/null || true
}

supacloud_fetch_attestation_bundle() {
    local artifact_file="$1"
    local bundle_file="$2"
    local digest response
    digest=$(sha256sum "$artifact_file" | awk '{print $1}') || return 1
    [[ "$digest" =~ ^[0-9a-fA-F]{64}$ ]] || {
        echo "Unable to calculate the artifact digest for attestation lookup" >&2
        return 1
    }
    digest=$(printf '%s' "$digest" | tr '[:upper:]' '[:lower:]')
    response=$(supacloud_fetch_release_json \
        "https://api.github.com/repos/${SUPACLOUD_GITHUB_REPOSITORY}/attestations/sha256:${digest}") || {
        echo "Unable to download the public GitHub artifact attestation bundle" >&2
        return 1
    }
    if ! jq -ce '
        .attestations
        | if type != "array" or length == 0 or any(.[]; (.bundle | type) != "object")
          then error("no valid attestation bundles returned")
          else .[].bundle
          end
    ' <<< "$response" > "$bundle_file"; then
        echo "GitHub artifact attestation response did not contain a valid bundle" >&2
        return 1
    fi
}

supacloud_verify_attestation() (
    local artifact_file="$1"
    if supacloud_attestation_verifier_available; then
        local verification_output bundle_dir bundle_file
        bundle_dir=$(mktemp -d "${TMPDIR:-/tmp}/supacloud-attestation.XXXXXX") || return 1
        trap 'rm -rf -- "$bundle_dir"' EXIT
        trap 'trap - EXIT HUP INT TERM; rm -rf -- "$bundle_dir"; exit 1' HUP INT TERM
        bundle_file="${bundle_dir}/bundle.jsonl"
        if ! supacloud_fetch_attestation_bundle "$artifact_file" "$bundle_file"; then
            return 1
        fi
        if ! verification_output=$(gh attestation verify "$artifact_file" \
            --bundle "$bundle_file" \
            --repo "$SUPACLOUD_GITHUB_REPOSITORY" \
            --signer-workflow "$SUPACLOUD_ATTESTATION_SIGNER_WORKFLOW" \
            --source-ref "refs/heads/main" 2>&1); then
            echo "GitHub artifact attestation verification failed: ${verification_output}" >&2
            return 1
        fi
        supacloud_record_integrity_mode "github-attestation+same-release-sha256"
        return
    fi

    if [[ "${SUPACLOUD_ALLOW_UNVERIFIED_RELEASE:-false}" == "true" ]]; then
        echo "BREAK-GLASS LIMITED INTEGRITY MODE: artifact attestation verification is unavailable; only the same-release SHA256 checksum was verified." >&2
        supacloud_record_integrity_mode "break-glass:same-release-sha256-only"
        return 0
    fi

    echo "Artifact attestation verification is required, but gh attestation verify is unavailable. Install GitHub CLI or explicitly set SUPACLOUD_ALLOW_UNVERIFIED_RELEASE=true for emergency break-glass use." >&2
    return 1
)

supacloud_attestation_verifier_available() {
    local version help
    command -v gh >/dev/null 2>&1 || return 1
    version=$(supacloud_gh_version)
    [[ -n "$version" ]] || return 1
    supacloud_version_at_least "$version" "$SUPACLOUD_GH_MIN_VERSION" || return 1
    help=$(gh attestation verify --help 2>&1) || return 1
    grep -Eq -- '(^|[[:space:]])--bundle([=[:space:]]|$)' <<< "$help" || return 1
    grep -Eq -- '(^|[[:space:]])--signer-workflow([=[:space:]]|$)' <<< "$help" || return 1
    grep -Eq -- '(^|[[:space:]])--source-ref([=[:space:]]|$)' <<< "$help"
}

supacloud_download_release_asset() (
    local release_json="$1"
    local asset_name="$2"
    local destination="$3"
    local asset_kind="$4"
    local asset_url checksum_url temporary_artifact temporary_checksums

    asset_url=$(supacloud_release_asset_url "$release_json" "$asset_name") || return 1
    checksum_url=$(supacloud_release_asset_url "$release_json" SHA256SUMS) || return 1
    mkdir -p "$(dirname "$destination")"
    temporary_artifact=$(mktemp "${destination}.tmp.XXXXXX")
    temporary_checksums=$(mktemp "${destination}.SHA256SUMS.tmp.XXXXXX")
    trap 'rm -f "${temporary_artifact:-}" "${temporary_checksums:-}"' EXIT
    trap 'trap - EXIT HUP INT TERM; rm -f "${temporary_artifact:-}" "${temporary_checksums:-}"; exit 1' HUP INT TERM

    if ! supacloud_download_url "$asset_url" "$temporary_artifact" \
        || ! supacloud_download_release_metadata_url "$checksum_url" "$temporary_checksums" \
        || ! supacloud_verify_checksum "$temporary_artifact" "$asset_name" "$temporary_checksums"; then
        rm -f "$temporary_artifact" "$temporary_checksums"
        return 1
    fi

    # Authenticate the digest before parsing archives or inspecting binaries.
    if ! supacloud_verify_attestation "$temporary_artifact"; then
        rm -f "$temporary_artifact" "$temporary_checksums"
        return 1
    fi

    case "$asset_kind" in
        binary) supacloud_validate_binary "$temporary_artifact" "$asset_name" ;;
        tar) supacloud_validate_tar "$temporary_artifact" ;;
        *)
            echo "Unknown release asset kind: $asset_kind" >&2
            rm -f "$temporary_artifact" "$temporary_checksums"
            return 1
            ;;
    esac || {
        rm -f "$temporary_artifact" "$temporary_checksums"
        return 1
    }

    mv -f "$temporary_artifact" "$destination"
    temporary_artifact=""
    rm -f "$temporary_checksums"
    temporary_checksums=""
)

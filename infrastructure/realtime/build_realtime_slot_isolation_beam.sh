#!/usr/bin/env bash
# Build the one-module Realtime compatibility artifact without rebuilding the
# official image. The launcher mounts the resulting BEAM over the matching
# module path at runtime, so image identity and all bundled schema artifacts
# remain those of the official release.
set -euo pipefail

REALTIME_VERSION="${REALTIME_SLOT_ISOLATION_RUNTIME_VERSION:-2.133.0}"
REALTIME_SOURCE_REPOSITORY="${REALTIME_SLOT_ISOLATION_SOURCE_REPOSITORY:-https://github.com/supabase/realtime.git}"
REALTIME_SOURCE_COMMIT="${REALTIME_SLOT_ISOLATION_SOURCE_COMMIT:-139f4f2c5d1ae28a7892c03d462d16dc9efe89a9}"
REALTIME_SOURCE_FILE="lib/realtime/tenants/replication_connection.ex"
REALTIME_SOURCE_FILE_SHA256="4b61b97af2f8325963fe58a4f2eb32a52ea4af2af10f9051ab858207f6dd03e6"
REALTIME_PATCHED_SOURCE_FILE_SHA256="ca3a4b989f7601ed8a4eb7fe84635dc547fc0667f097aeb6cadb9b101d8ac02a"
REALTIME_BASE_IMAGE="public.ecr.aws/supabase/realtime:v2.133.0"
REALTIME_IMAGE_INDEX_DIGEST="sha256:974f7db71f140f54c63c8d7a8d8643109704c3ee99ff735678a803fdfbfdcefb"
REALTIME_RESOLVED_IMAGE="public.ecr.aws/supabase/realtime@$REALTIME_IMAGE_INDEX_DIGEST"
REALTIME_IMAGE="${REALTIME_IMAGE:-$REALTIME_BASE_IMAGE}"
REALTIME_BUILDER_IMAGE_INDEX_DIGEST="sha256:5db16aff7fdc118d4b268c7104f3c0409049b3255d503e08ca00a7e29050a408"
REALTIME_BUILDER_IMAGE="docker.io/hexpm/elixir@$REALTIME_BUILDER_IMAGE_INDEX_DIGEST"
REALTIME_SLOT_ISOLATION_OUTPUT_DIR="${1:-${REALTIME_SLOT_ISOLATION_OUTPUT_DIR:-/opt/supacloud/realtime-slot-isolation}}"
REALTIME_SLOT_ISOLATION_APPLY_SCRIPT="${REALTIME_SLOT_ISOLATION_APPLY_SCRIPT:-}"
REALTIME_SLOT_ISOLATION_MODULE="Elixir.Realtime.Tenants.ReplicationConnection.beam"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINNED_VERIFY_SCRIPT="$SCRIPT_DIR/verify_slot_isolation_artifact.py"
if [[ -n "${REALTIME_SLOT_ISOLATION_VERIFY_SCRIPT:-}" && "$REALTIME_SLOT_ISOLATION_VERIFY_SCRIPT" != "$PINNED_VERIFY_SCRIPT" ]]; then
    printf 'Realtime slot-isolation verifier override is not allowed\n' >&2
    exit 1
fi
REALTIME_SLOT_ISOLATION_VERIFY_SCRIPT="$PINNED_VERIFY_SCRIPT"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'USAGE'
Usage: build_realtime_slot_isolation_beam.sh [OUTPUT_DIR]

Build the pinned Realtime 2.133.0 tenant-slot isolation BEAM artifact.
The output directory contains the module BEAM and manifest.json.
USAGE
    exit 0
fi

if [[ "$REALTIME_VERSION" != "2.133.0" ]]; then
    printf 'unsupported Realtime slot-isolation runtime: %s\n' "$REALTIME_VERSION" >&2
    exit 1
fi
[[ "$REALTIME_SOURCE_REPOSITORY" == "https://github.com/supabase/realtime.git" ]] || {
    printf 'slot-isolation requires the pinned Realtime source repository\n' >&2
    exit 1
}
[[ "$REALTIME_SOURCE_COMMIT" == "139f4f2c5d1ae28a7892c03d462d16dc9efe89a9" ]] || {
    printf 'slot-isolation requires the pinned Realtime source commit\n' >&2
    exit 1
}

[[ "$REALTIME_IMAGE" == "$REALTIME_BASE_IMAGE" || "$REALTIME_IMAGE" == "$REALTIME_RESOLVED_IMAGE" ]] || {
    printf 'slot-isolation requires the pinned official image %s (got %s)\n' "$REALTIME_RESOLVED_IMAGE" "$REALTIME_IMAGE" >&2
    exit 1
}
[[ "${REALTIME_SLOT_ISOLATION_BUILDER_IMAGE:-$REALTIME_BUILDER_IMAGE}" == "$REALTIME_BUILDER_IMAGE" ]] || {
    printf 'slot-isolation requires the pinned builder image %s\n' "$REALTIME_BUILDER_IMAGE" >&2
    exit 1
}

REALTIME_SLOT_ISOLATION_EXPECTED_UID_VALUE=0
if [[ -n "${REALTIME_SLOT_ISOLATION_EXPECTED_UID:-}" ]]; then
    if [[ "${REALTIME_SLOT_ISOLATION_TEST_ALLOW_UID_OVERRIDE:-false}" != "true" ]]; then
        printf 'Realtime artifact owner override is only allowed for tests\n' >&2
        exit 1
    fi
    REALTIME_SLOT_ISOLATION_EXPECTED_UID_VALUE="$REALTIME_SLOT_ISOLATION_EXPECTED_UID"
fi

if [[ -n "${CONTAINER_RUNTIME:-}" ]]; then
    CONTAINER_RUNTIME_BIN="$CONTAINER_RUNTIME"
elif command -v podman >/dev/null 2>&1; then
    CONTAINER_RUNTIME_BIN="$(command -v podman)"
elif command -v docker >/dev/null 2>&1; then
    CONTAINER_RUNTIME_BIN="$(command -v docker)"
else
    printf 'podman or docker is required to build the Realtime slot-isolation artifact\n' >&2
    exit 1
fi

if [[ -z "$REALTIME_SLOT_ISOLATION_APPLY_SCRIPT" ]]; then
    REALTIME_SLOT_ISOLATION_APPLY_SCRIPT="$SCRIPT_DIR/apply-slot-isolation.py"
fi

for command_name in git python3 install uname; do
    command -v "$command_name" >/dev/null 2>&1 || {
        printf '%s is required to build the Realtime slot-isolation artifact\n' "$command_name" >&2
        exit 1
    }
done

case "$(uname -m)" in
    x86_64|amd64) REALTIME_ARCHITECTURE=amd64 ;;
    aarch64|arm64) REALTIME_ARCHITECTURE=arm64 ;;
    *) printf 'unsupported Realtime build architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac
case "$REALTIME_ARCHITECTURE" in
    amd64)
        REALTIME_PLATFORM_MANIFEST_DIGEST="sha256:109c6ea8ecd6c84c3b36047fe78a055c27702f6d9e19c441958b129a9bd468c3"
        REALTIME_CONFIG_DIGEST="sha256:bcaec521eb08dc811d88119ee5bcac7671188d8937cffc12d3bf23c890bb636b"
        BUILDER_PLATFORM_MANIFEST_DIGEST="sha256:77d1ed571b8fd66d60940c030d24a0f3a0ca48735155534e3132e8209ae56b86"
        ;;
    arm64)
        REALTIME_PLATFORM_MANIFEST_DIGEST="sha256:172c1b386ed7b5969bd7fbce8e31b3c65050e0c39f4191bd637d6de811b81315"
        REALTIME_CONFIG_DIGEST="sha256:1ee6d7247f3f3809289524539cd06f6f86d4c50e5639d1ef28f388a9e4fefaa4"
        BUILDER_PLATFORM_MANIFEST_DIGEST="sha256:51030f0252b08486eeb38e27fe6cf2e9769538594244734a7184ad8d6236be10"
        ;;
esac

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

sha256_stdin() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum | awk '{print $1}'
    else
        shasum -a 256 | awk '{print $1}'
    fi
}

manifest_path="$REALTIME_SLOT_ISOLATION_OUTPUT_DIR/manifest.json"
beam_path="$REALTIME_SLOT_ISOLATION_OUTPUT_DIR/$REALTIME_SLOT_ISOLATION_MODULE"

if [[ "${REALTIME_SLOT_ISOLATION_FORCE_REBUILD:-false}" != "true" && -f "$manifest_path" && -f "$beam_path" ]]; then
    if python3 "$REALTIME_SLOT_ISOLATION_VERIFY_SCRIPT" \
        --artifact-dir "$REALTIME_SLOT_ISOLATION_OUTPUT_DIR" \
        --manifest "$manifest_path" \
        --beam "$beam_path" \
        --architecture "$REALTIME_ARCHITECTURE" \
        --expected-uid "$REALTIME_SLOT_ISOLATION_EXPECTED_UID_VALUE"
    then
        printf 'existing Realtime slot-isolation artifact is current\n'
        exit 0
    fi
fi

workdir="$(mktemp -d "${TMPDIR:-/tmp}/supacloud-realtime-slot.XXXXXX")"
container_id=""
cleanup() {
    if [[ -n "$container_id" ]]; then
        "$CONTAINER_RUNTIME_BIN" rm -f "$container_id" >/dev/null 2>&1 || true
    fi
    if [[ -n "${workdir:-}" && -d "$workdir" ]]; then
        rm -rf -- "$workdir"
    fi
}
trap cleanup EXIT

source_dir="$workdir/source"
runtime_dir="$workdir/runtime"
compiled_dir="$workdir/compiled"
mkdir -p "$source_dir" "$runtime_dir" "$compiled_dir"
chmod 700 "$workdir" "$source_dir" "$runtime_dir" "$compiled_dir"

git -C "$source_dir" init -q
git -C "$source_dir" remote add origin "$REALTIME_SOURCE_REPOSITORY"
if ! git -C "$source_dir" fetch --depth=1 origin "$REALTIME_SOURCE_COMMIT"; then
    git -C "$source_dir" fetch --depth=1 origin "refs/tags/v$REALTIME_VERSION:refs/tags/v$REALTIME_VERSION"
fi
git -C "$source_dir" checkout --detach -q "$REALTIME_SOURCE_COMMIT"
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$REALTIME_SOURCE_COMMIT" ]] || {
    printf 'Realtime source checkout is not the pinned commit\n' >&2
    exit 1
}

source_path="$source_dir/$REALTIME_SOURCE_FILE"
[[ -f "$source_path" ]] || {
    printf 'Realtime source file is missing: %s\n' "$REALTIME_SOURCE_FILE" >&2
    exit 1
}
actual_source_sha="$(sha256_file "$source_path")"
[[ "$actual_source_sha" == "$REALTIME_SOURCE_FILE_SHA256" ]] || {
    printf 'Realtime source checksum mismatch: expected %s, got %s\n' "$REALTIME_SOURCE_FILE_SHA256" "$actual_source_sha" >&2
    exit 1
}
python3 "$REALTIME_SLOT_ISOLATION_APPLY_SCRIPT" "$source_path"
actual_patched_sha="$(sha256_file "$source_path")"
[[ "$actual_patched_sha" == "$REALTIME_PATCHED_SOURCE_FILE_SHA256" ]] || {
    printf 'Realtime patched source checksum mismatch: expected %s, got %s\n' "$REALTIME_PATCHED_SOURCE_FILE_SHA256" "$actual_patched_sha" >&2
    exit 1
}

if ! "$CONTAINER_RUNTIME_BIN" image inspect "$REALTIME_RESOLVED_IMAGE" >/dev/null 2>&1; then
    "$CONTAINER_RUNTIME_BIN" pull "$REALTIME_RESOLVED_IMAGE"
fi
if ! "$CONTAINER_RUNTIME_BIN" image inspect "$REALTIME_BUILDER_IMAGE" >/dev/null 2>&1; then
    "$CONTAINER_RUNTIME_BIN" pull "$REALTIME_BUILDER_IMAGE"
fi
python3 - \
    "$CONTAINER_RUNTIME_BIN" \
    "$REALTIME_ARCHITECTURE" \
    "$REALTIME_RESOLVED_IMAGE" \
    "$REALTIME_IMAGE_INDEX_DIGEST" \
    "$REALTIME_PLATFORM_MANIFEST_DIGEST" \
    "$REALTIME_CONFIG_DIGEST" \
    "$REALTIME_BUILDER_IMAGE" \
    "$REALTIME_BUILDER_IMAGE_INDEX_DIGEST" \
    "$BUILDER_PLATFORM_MANIFEST_DIGEST" <<'PY'
import json, subprocess, sys
(
    runtime,
    arch,
    runtime_image,
    runtime_index_digest,
    runtime_platform_digest,
    runtime_config_digest,
    builder_image,
    builder_index_digest,
    builder_platform_digest,
) = sys.argv[1:]

def verify(image, role, index_digest, platform_digest, config_digest=None):
    data = json.loads(subprocess.check_output([runtime, "image", "inspect", image], text=True))[0]
    actual_arch = data.get("Architecture") or data.get("architecture")
    if actual_arch == "x86_64":
        actual_arch = "amd64"
    elif actual_arch == "aarch64":
        actual_arch = "arm64"
    if actual_arch != arch:
        raise SystemExit(f"{role} image architecture is outside the trust root")

    actual_id = str(data.get("Id") or data.get("ID") or "")
    if actual_id and not actual_id.startswith("sha256:"):
        actual_id = "sha256:" + actual_id
    if config_digest and actual_id != config_digest:
        raise SystemExit(f"{role} image config digest is outside the trust root")

    observed_digests = {str(data.get("Digest") or "")}
    observed_digests.update(str(value).rsplit("@", 1)[-1] for value in (data.get("RepoDigests") or []))
    if not observed_digests.intersection({index_digest, platform_digest}):
        raise SystemExit(f"{role} image digest is outside the trust root")

verify(
    runtime_image,
    "runtime",
    runtime_index_digest,
    runtime_platform_digest,
    runtime_config_digest,
)
verify(builder_image, "builder", builder_index_digest, builder_platform_digest)
PY
container_id="$("$CONTAINER_RUNTIME_BIN" create "$REALTIME_RESOLVED_IMAGE" /bin/true)"
"$CONTAINER_RUNTIME_BIN" cp "$container_id:/app/lib" "$runtime_dir/"
"$CONTAINER_RUNTIME_BIN" rm -f "$container_id" >/dev/null
container_id=""
runtime_ebin="$runtime_dir/lib/realtime-$REALTIME_VERSION/ebin"
[[ -d "$runtime_ebin" ]] || {
    printf 'official Realtime image does not contain %s\n' "$runtime_ebin" >&2
    exit 1
}

cat > "$workdir/validate.exs" <<'ELIXIR'
module = Realtime.Tenants.ReplicationConnection
Application.put_env(:realtime, :slot_name_suffix, String.duplicate("x", 200))
tenant_token = fn tenant_id ->
  digest = :crypto.hash(:sha256, tenant_id) |> Base.encode16(case: :lower)
  "tenant_" <> binary_part(digest, 0, 10)
end
first = module.replication_slot_name("realtime", "messages", "tenant-a")
second = module.replication_slot_name("realtime", "messages", "tenant-b")
legacy = module.replication_slot_name("realtime", "messages")
checks = [
  byte_size(first) <= 63,
  byte_size(second) <= 63,
  byte_size(legacy) <= 63,
  first != second,
  String.ends_with?(first, tenant_token.("tenant-a")),
  String.ends_with?(second, tenant_token.("tenant-b"))
]
unless Enum.all?(checks), do: raise "tenant slot isolation validation failed"
IO.puts("tenant slot isolation validation passed")
ELIXIR

# shellcheck disable=SC2016 # The single-quoted program runs inside the builder container.
"$CONTAINER_RUNTIME_BIN" run --rm --network none \
    -e MIX_ENV=prod \
    -v "$source_dir:/source:ro" \
    -v "$runtime_dir:/runtime:ro" \
    -v "$compiled_dir:/output:rw" \
    -v "$workdir/validate.exs:/validation/validate.exs:ro" \
    "$REALTIME_BUILDER_IMAGE" /bin/sh -eu -c '
        set -- elixirc --ignore-module-conflict -o /output
        for path in /runtime/lib/*/ebin; do
            [ -d "$path" ] || continue
            set -- "$@" -pa "$path"
        done
        set -- "$@" /source/lib/realtime/tenants/replication_connection.ex
        "$@"
        test -s /output/Elixir.Realtime.Tenants.ReplicationConnection.beam
        set -- elixir
        for path in /runtime/lib/*/ebin; do
            [ -d "$path" ] || continue
            set -- "$@" -pa "$path"
        done
        set -- "$@" -pa /output /validation/validate.exs
        "$@"
    '

beam_sha="$(sha256_file "$compiled_dir/$REALTIME_SLOT_ISOLATION_MODULE")"
manifest_tmp="$workdir/manifest.json"
python3 - "$manifest_tmp" "$REALTIME_ARCHITECTURE" "$beam_sha" "$REALTIME_SLOT_ISOLATION_VERIFY_SCRIPT" <<'PY'
import json
import importlib.util
import pathlib
import sys

output, architecture, beam_sha, verifier_path = sys.argv[1:]
spec = importlib.util.spec_from_file_location("slot_verifier", verifier_path)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)
payload = module.expected_manifest(architecture, beam_sha)
pathlib.Path(output).write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
PY

install -d -m 0755 "$REALTIME_SLOT_ISOLATION_OUTPUT_DIR"
install -m 0444 "$compiled_dir/$REALTIME_SLOT_ISOLATION_MODULE" "$REALTIME_SLOT_ISOLATION_OUTPUT_DIR/.$REALTIME_SLOT_ISOLATION_MODULE.new"
install -m 0444 "$manifest_tmp" "$REALTIME_SLOT_ISOLATION_OUTPUT_DIR/.manifest.json.new"
mv -f "$REALTIME_SLOT_ISOLATION_OUTPUT_DIR/.$REALTIME_SLOT_ISOLATION_MODULE.new" "$beam_path"
mv -f "$REALTIME_SLOT_ISOLATION_OUTPUT_DIR/.manifest.json.new" "$manifest_path"
chmod 0755 "$REALTIME_SLOT_ISOLATION_OUTPUT_DIR"
chmod 0444 "$beam_path" "$manifest_path"
python3 "$REALTIME_SLOT_ISOLATION_VERIFY_SCRIPT" \
    --artifact-dir "$REALTIME_SLOT_ISOLATION_OUTPUT_DIR" \
    --manifest "$manifest_path" \
    --beam "$beam_path" \
    --architecture "$REALTIME_ARCHITECTURE" \
    --expected-uid "$REALTIME_SLOT_ISOLATION_EXPECTED_UID_VALUE"
printf 'built Realtime slot-isolation artifact %s (%s)\n' "$REALTIME_VERSION" "$beam_sha"

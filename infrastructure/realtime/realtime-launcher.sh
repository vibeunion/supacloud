#!/usr/bin/env bash
# Start the official Supabase Realtime image with the verified tenant-slot
# isolation module overlaid as a read-only bind mount.
set -euo pipefail

REALTIME_VERSION="${REALTIME_SLOT_ISOLATION_RUNTIME_VERSION:-2.133.0}"
REALTIME_BASE_IMAGE="public.ecr.aws/supabase/realtime:v2.133.0"
REALTIME_IMAGE_INDEX_DIGEST="sha256:974f7db71f140f54c63c8d7a8d8643109704c3ee99ff735678a803fdfbfdcefb"
REALTIME_RESOLVED_IMAGE="public.ecr.aws/supabase/realtime@$REALTIME_IMAGE_INDEX_DIGEST"
REALTIME_SLOT_ISOLATION_MODULE="Elixir.Realtime.Tenants.ReplicationConnection.beam"
REALTIME_SLOT_ISOLATION_CONTAINER_PATH="/app/lib/realtime-${REALTIME_VERSION}/ebin/${REALTIME_SLOT_ISOLATION_MODULE}"
REALTIME_SLOT_ISOLATION_ARTIFACT_DIR="${REALTIME_SLOT_ISOLATION_ARTIFACT_DIR:-/opt/supacloud/realtime-slot-isolation}"
REALTIME_SLOT_ISOLATION_MANIFEST="${REALTIME_SLOT_ISOLATION_MANIFEST:-$REALTIME_SLOT_ISOLATION_ARTIFACT_DIR/manifest.json}"
REALTIME_SLOT_ISOLATION_BEAM="${REALTIME_SLOT_ISOLATION_BEAM:-$REALTIME_SLOT_ISOLATION_ARTIFACT_DIR/$REALTIME_SLOT_ISOLATION_MODULE}"
REALTIME_IMAGE="${REALTIME_IMAGE:-$REALTIME_BASE_IMAGE}"
REALTIME_CONTAINER_NAME="${REALTIME_CONTAINER_NAME:-supacloud-realtime}"
REALTIME_CONTAINER_ENV_FILE="${REALTIME_CONTAINER_ENV_FILE:-/etc/supabase/realtime-container.env}"
PINNED_VERIFY_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_slot_isolation_artifact.py"
if [[ -n "${REALTIME_SLOT_ISOLATION_VERIFY_SCRIPT:-}" && "$REALTIME_SLOT_ISOLATION_VERIFY_SCRIPT" != "$PINNED_VERIFY_SCRIPT" ]]; then
    printf 'Realtime slot-isolation verifier override is not allowed\n' >&2
    exit 1
fi
REALTIME_SLOT_ISOLATION_VERIFY_SCRIPT="$PINNED_VERIFY_SCRIPT"

case "$(uname -m)" in
    x86_64|amd64) REALTIME_ARCHITECTURE=amd64 ;;
    aarch64|arm64) REALTIME_ARCHITECTURE=arm64 ;;
    *) printf 'unsupported Realtime architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac
[[ "$REALTIME_IMAGE" == "$REALTIME_BASE_IMAGE" || "$REALTIME_IMAGE" == "$REALTIME_RESOLVED_IMAGE" ]] || {
    printf 'Realtime image is outside the pinned trust root: %s\n' "$REALTIME_IMAGE" >&2
    exit 1
}

if [[ "${1:-}" != "--validate-only" ]]; then
if [[ -n "${CONTAINER_RUNTIME:-}" ]]; then
    CONTAINER_RUNTIME_BIN="$CONTAINER_RUNTIME"
elif [[ -x /usr/bin/podman ]]; then
    CONTAINER_RUNTIME_BIN=/usr/bin/podman
elif command -v podman >/dev/null 2>&1; then
    CONTAINER_RUNTIME_BIN="$(command -v podman)"
elif command -v docker >/dev/null 2>&1; then
    CONTAINER_RUNTIME_BIN="$(command -v docker)"
else
    printf 'podman or docker is required to start Realtime\n' >&2
    exit 1
fi

if [[ "$CONTAINER_RUNTIME_BIN" == */* ]]; then
    [[ -x "$CONTAINER_RUNTIME_BIN" ]] || {
        printf 'container runtime is not executable: %s\n' "$CONTAINER_RUNTIME_BIN" >&2
        exit 1
    }
else
    CONTAINER_RUNTIME_BIN="$(command -v "$CONTAINER_RUNTIME_BIN")"
fi
fi

validate_artifact() {
    expected_uid=0
    if [[ "${1:-}" == "--validate-only" && "${REALTIME_SLOT_ISOLATION_TEST_ALLOW_UID_OVERRIDE:-false}" == "true" ]]; then
        expected_uid="${REALTIME_SLOT_ISOLATION_EXPECTED_UID:-$(id -u)}"
    elif [[ -n "${REALTIME_SLOT_ISOLATION_EXPECTED_UID:-}" ]]; then
        printf 'Realtime artifact owner override is only allowed for validate-only tests\n' >&2
        return 1
    fi
    python3 "$REALTIME_SLOT_ISOLATION_VERIFY_SCRIPT" \
        --artifact-dir "$REALTIME_SLOT_ISOLATION_ARTIFACT_DIR" \
        --manifest "$REALTIME_SLOT_ISOLATION_MANIFEST" \
        --beam "$REALTIME_SLOT_ISOLATION_BEAM" \
        --architecture "$REALTIME_ARCHITECTURE" \
        --expected-uid "$expected_uid"
}

validate_artifact "${1:-}"

if [[ "${1:-}" == "--validate-only" ]]; then
    [[ "$#" -eq 1 ]] || {
        printf 'usage: realtime-launcher.sh [--validate-only]\n' >&2
        exit 2
    }
    exit 0
fi
if [[ "$#" -ne 0 ]]; then
    printf 'usage: realtime-launcher.sh [--validate-only]\n' >&2
    exit 2
fi
[[ -r "$REALTIME_CONTAINER_ENV_FILE" ]] || {
    printf 'Realtime container environment file is missing: %s\n' "$REALTIME_CONTAINER_ENV_FILE" >&2
    exit 1
}
[[ "$REALTIME_CONTAINER_NAME" =~ ^[a-zA-Z0-9_.-]+$ ]] || {
    printf 'invalid Realtime container name\n' >&2
    exit 1
}
[[ "$REALTIME_IMAGE" != *$'\\n'* && "$REALTIME_IMAGE" != *$'\\r'* ]] || {
    printf 'invalid Realtime image reference\n' >&2
    exit 1
}

runtime_name="$(basename "$CONTAINER_RUNTIME_BIN")"
case "$runtime_name" in
    podman)
        run_args=(run --replace --pull=never --name "$REALTIME_CONTAINER_NAME")
        ;;
    docker)
        # Docker has no Podman-compatible --replace flag. Remove only the
        # named container, then create the replacement with validated inputs.
        "$CONTAINER_RUNTIME_BIN" rm -f "$REALTIME_CONTAINER_NAME" >/dev/null 2>&1 || true
        run_args=(run --pull=never --name "$REALTIME_CONTAINER_NAME")
        ;;
    *)
        printf 'unsupported Realtime container runtime: %s\n' "$runtime_name" >&2
        exit 1
        ;;
esac
network_mode="${REALTIME_NETWORK_MODE:-host}"
[[ "$network_mode" =~ ^[a-zA-Z0-9_.-]+$ ]] || {
    printf 'invalid Realtime network mode\n' >&2
    exit 1
}
run_args+=(--network "$network_mode" --env-file "$REALTIME_CONTAINER_ENV_FILE")
if [[ -n "${REALTIME_PUBLISH_PORT:-}" ]]; then
    [[ "$REALTIME_PUBLISH_PORT" != *$'\\n'* && "$REALTIME_PUBLISH_PORT" != *$'\\r'* ]] || {
        printf 'invalid Realtime published port\n' >&2
        exit 1
    }
    run_args+=(--publish "$REALTIME_PUBLISH_PORT")
fi
run_args+=(--volume "$REALTIME_SLOT_ISOLATION_BEAM:$REALTIME_SLOT_ISOLATION_CONTAINER_PATH:ro,Z")
if [[ "${REALTIME_PRIVILEGED:-false}" == "true" ]]; then
    run_args+=(--privileged)
elif [[ "${REALTIME_PRIVILEGED:-false}" != "false" ]]; then
    printf 'REALTIME_PRIVILEGED must be true or false\n' >&2
    exit 1
fi
if [[ "${REALTIME_RUN_DETACHED:-false}" == "true" ]]; then
    run_args+=(--detach --restart=always)
elif [[ "${REALTIME_RUN_DETACHED:-false}" != "false" ]]; then
    printf 'REALTIME_RUN_DETACHED must be true or false\n' >&2
    exit 1
fi
exec "$CONTAINER_RUNTIME_BIN" "${run_args[@]}" "$REALTIME_RESOLVED_IMAGE"

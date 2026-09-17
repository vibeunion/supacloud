#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 0 ]; then
  echo "Usage: bash scripts/publish-postgres-image.sh (no build overrides)" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "Publish requires a clean checkout; commit the verified image sources first." >&2
  exit 1
fi
revision="$(git rev-parse HEAD)"
remote_main="$(git ls-remote --exit-code origin refs/heads/main | cut -f1)"
if [ "$revision" != "$remote_main" ]; then
  echo "Publish requires the current origin/main commit." >&2
  exit 1
fi
image="${POSTGRES_IMAGE:-ghcr.io/vibeunion/supacloud/postgres}"
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --label "org.opencontainers.image.revision=$revision" \
  --tag "$image:sha-${revision:0:7}" \
  --tag "$image:latest" \
  --push docker/self-host/postgres

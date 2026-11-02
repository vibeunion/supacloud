#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# @supacloud/management-api consumes the built @supacloud/db entrypoint.
# Build its local dependencies before installing the file: dependency copy.
(cd packages/contracts && bun install --frozen-lockfile && bun run build)
(cd packages/db && bun install --frozen-lockfile && bun run build)
(cd packages/delivery && bun install --frozen-lockfile)

rm -rf packages/management-api/node_modules/@supacloud/db
(cd packages/management-api && bun install --frozen-lockfile)

#!/bin/bash
# Build custom Supabase Studio for SupaCloud

set -e

echo "=== Building SupaCloud Studio ==="

# Set environment variables for build
export NEXT_PUBLIC_IS_PLATFORM=true
export NEXT_PUBLIC_API_URL=https://studio.esgfarm.cn/api
export NEXT_PUBLIC_SITE_URL=https://studio.esgfarm.cn
export FORCE_ASSET_CDN=-1
export SKIP_ASSET_UPLOAD=1

# Build
cd apps/studio
pnpm build

echo "=== Build Complete ==="
echo "Output: apps/studio/.next/standalone"

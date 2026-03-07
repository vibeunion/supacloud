#!/bin/bash
# SupaCloud Studio Build Script
# 构建启用云平台模式的 Studio

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="${SCRIPT_DIR}/../../supabase-studio"
OUTPUT_DIR="${SCRIPT_DIR}/dist"

echo "=== SupaCloud Studio Build ==="
echo ""

# 检查源码目录
if [ ! -d "$SUPABASE_DIR" ]; then
    echo "Error: Supabase source not found at $SUPABASE_DIR"
    echo "Please clone: git clone https://github.com/supabase/supabase.git"
    exit 1
fi

# 加载环境变量
if [ -f "${SCRIPT_DIR}/.env.build" ]; then
    echo "Loading build environment..."
    export $(grep -v '^#' "${SCRIPT_DIR}/.env.build" | xargs)
fi

# 显示构建配置
echo "Build Configuration:"
echo "  NEXT_PUBLIC_IS_PLATFORM: ${NEXT_PUBLIC_IS_PLATFORM}"
echo "  NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL}"
echo "  NEXT_PUBLIC_SITE_URL: ${NEXT_PUBLIC_SITE_URL}"
echo ""

# 进入源码目录
cd "$SUPABASE_DIR/apps/studio"

# 安装依赖
echo "=== Installing dependencies ==="
corepack enable pnpm
pnpm install --frozen-lockfile

# 构建
echo ""
echo "=== Building Studio ==="
pnpm build

# 创建输出目录
mkdir -p "$OUTPUT_DIR"

# 复制构建产物
echo ""
echo "=== Copying build artifacts ==="
cp -r .next/standalone "${OUTPUT_DIR}/"
cp -r .next/static "${OUTPUT_DIR}/.next/"
cp -r public "${OUTPUT_DIR}/"

echo ""
echo "=== Build Complete ==="
echo "Output: $OUTPUT_DIR"
echo ""
echo "To run: cd $OUTPUT_DIR && node server.js"

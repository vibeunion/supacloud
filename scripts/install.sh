#!/bin/bash
set -e

# SupaCloud Installer for Linux/macOS

REPO="zuohuadong/supacloud"
GITHUB_URL="https://github.com"
API_URL="https://api.github.com"

# Proxy support
if [ "$1" == "cn" ]; then
    echo "Using ghproxy.net for faster download in China..."
    GITHUB_URL="https://ghproxy.net/https://github.com"
fi

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Linux)     PLATFORM="linux" ;;
    Darwin)    PLATFORM="darwin" ;;
    *)         echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
    x86_64)    ARCH="x64" ;;
    aarch64)   ARCH="arm64" ;;
    arm64)     ARCH="arm64" ;;
    *)         echo "Unsupported Architecture: $ARCH"; exit 1 ;;
esac

BINARY_NAME="supacloud-${PLATFORM}-${ARCH}"
TARGET_DIR="/usr/local/bin"
TARGET_FILE="${TARGET_DIR}/supacloud"

echo "Detecting latest release..."
# Get latest release tag
LATEST_TAG=$(curl -s "${API_URL}/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')

if [ -z "$LATEST_TAG" ]; then
    echo "Failed to fetch latest release tag. Using 'main' or checking network."
    # Fallback logic or exit
    exit 1
fi

DOWNLOAD_URL="${GITHUB_URL}/${REPO}/releases/download/${LATEST_TAG}/${BINARY_NAME}"

echo "Downloading SupaCloud CLI (${LATEST_TAG}) for ${PLATFORM}/${ARCH}..."
echo "URL: ${DOWNLOAD_URL}"

curl -L "${DOWNLOAD_URL}" -o supacloud_temp

echo "Installing to ${TARGET_FILE}..."
chmod +x supacloud_temp

if [ -w "${TARGET_DIR}" ]; then
    mv supacloud_temp "${TARGET_FILE}"
else
    echo "Sudo access required to move binary to ${TARGET_DIR}"
    sudo mv supacloud_temp "${TARGET_FILE}"
fi

echo "✅ SupaCloud CLI installed successfully!"
echo "Run 'supacloud help' to get started."

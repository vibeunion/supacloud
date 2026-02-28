#!/bin/bash
set -e

# Configuration
CONSOLE_PORT=${CONSOLE_PORT:-3000}
API_URL=${API_URL:-http://localhost:9090}
IMAGE_NAME="supacloud-web-console"
CONTAINER_NAME="supacloud-web-console"

# Determine container runtime
if command -v docker &> /dev/null; then
    RUNTIME="docker"
elif command -v podman &> /dev/null; then
    RUNTIME="podman"
else
    echo "Error: Neither docker nor podman found."
    exit 1
fi

echo "Using container runtime: $RUNTIME"

# Build the image
echo "Building web console image..."
cd "$(dirname "$0")/../packages/web-console"
$RUNTIME build -t $IMAGE_NAME .

# Stop existing container
echo "Stopping existing container..."
$RUNTIME stop $CONTAINER_NAME 2>/dev/null || true
$RUNTIME rm $CONTAINER_NAME 2>/dev/null || true

# Run new container
echo "Starting web console container..."
# Use host network to access localhost API easily
$RUNTIME run -d \
    --name $CONTAINER_NAME \
    --network host \
    -e PORT=$CONSOLE_PORT \
    -e SUPACLOUD_API_URL=$API_URL \
    --restart unless-stopped \
    $IMAGE_NAME

echo "Web console deployed successfully on port $CONSOLE_PORT"

#!/bin/bash
set -e

# SupaCloud Deployment Script with Podman
# Target System: Linux (Debian/Ubuntu/CentOS compatible logic)

echo ">>> Starting SupaCloud Deployment with Podman..."

# 1. Install Podman
echo ">>> Installing Podman..."
if command -v apt-get &> /dev/null; then
    apt-get update
    apt-get install -y podman
elif command -v yum &> /dev/null; then
    yum install -y podman
else
    echo "Unsupported package manager. Please install Podman manually."
    exit 1
fi

# 2. Configure Podman as Docker
echo ">>> Configuring Podman as Docker replacement..."
# Try to install podman-docker emulation package if available
if command -v apt-get &> /dev/null; then
    apt-get install -y podman-docker || true
elif command -v yum &> /dev/null; then
    yum install -y podman-docker || true
fi

# Ensure 'docker' command exists via alias or wrapper
if ! command -v docker &> /dev/null; then
    echo "Creating docker alias..."
    echo '#!/bin/sh
    exec podman "$@"' > /usr/bin/docker
    chmod +x /usr/bin/docker
fi

# 3. Enable Podman Socket (Critical for docker-compose and generic tools)
echo ">>> Enabling Podman Socket..."
systemctl enable --now podman.socket

# Create symlink for /var/run/docker.sock compatibility
if [ ! -e /var/run/docker.sock ]; then
    echo "Linking /var/run/docker.sock to Podman socket..."
    ln -s /run/podman/podman.sock /var/run/docker.sock
fi

# Test Docker Socket
if curl -s --unix-socket /var/run/docker.sock http://localhost/_ping > /dev/null; then
    echo "✅ Docker Socket is active and accessible."
else
    echo "❌ Failed to access Docker Socket. Please check podman.socket status."
    exit 1
fi

# 4. Install Docker Compose (Standalone Binary)
echo ">>> Installing Docker Compose..."
COMPOSE_VERSION="v2.29.1"
COMPOSE_URL="https://ghproxy.net/https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64"

curl -SL "${COMPOSE_URL}" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose

if docker-compose version &> /dev/null; then
    echo "✅ Docker Compose installed: $(docker-compose version)"
else
    echo "❌ Docker Compose installation failed."
    exit 1
fi

# 5. Install SupaCloud CLI
echo ">>> Installing SupaCloud CLI..."
export SUPACLOUD_CN=1
curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/zuohuadong/supacloud/main/scripts/install.sh | bash -s cn

# 6. Initialize and Start SupaCloud
echo ">>> Initializing SupaCloud Workspace..."
WORKSPACE_DIR="/opt/supacloud"
mkdir -p "${WORKSPACE_DIR}"
cd "${WORKSPACE_DIR}"

if [ ! -f "base/docker-compose.yml" ]; then
    supacloud init
else
    echo "SupaCloud already initialized."
fi

echo ">>> Starting SupaCloud..."
supacloud start

echo ">>> Deployment Complete!"
echo "Access Manager at: http://$(curl -s ifconfig.me):8888"

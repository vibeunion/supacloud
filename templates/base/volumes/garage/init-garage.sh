#!/bin/bash
set -e

# Install dependencies
apk add --no-cache curl

# Download Garage Binary
echo "Downloading Garage CLI..."
curl -L -o /bin/garage https://garagehq.deuxfleurs.fr/_releases/v0.9.4/x86_64-unknown-linux-musl/garage
chmod +x /bin/garage

GARAGE_BIN="/bin/garage -r garage:3901"

echo "waiting for garage..."
until curl -s http://garage:3900/health > /dev/null; do
  sleep 1
done
echo "garage started."

# 检查是否已经初始化 (通过检查 key 是否存在)
if $GARAGE_BIN key list | grep -q "supabase-key"; then
    echo "Garage already initialized."
else
    echo "Initializing Garage..."
    
    # 1. 设置布局 (单机模式)
    $GARAGE_BIN layout assign -z dc1 -c 1G garage
    $GARAGE_BIN layout apply --version 1
    
    # 2. 创建 Key 并保存到共享卷/文件，供宿主机读取
    # 注意：更优雅的方式是允许传入自定义 Key，但 Garage 命令行不支持指定 Secret Key，是随机生成的。
    # 变通方案：创建 Key 后 awk 提取，写入一个 .env 片段文件
    
    KEY_OUTPUT=$($GARAGE_BIN key create supabase-key)
    ACCESS_KEY=$(echo "$KEY_OUTPUT" | grep "Key ID" | awk '{print $3}')
    SECRET_KEY=$(echo "$KEY_OUTPUT" | grep "Secret Key" | awk '{print $3}')
    
    echo "Generated Keys:"
    echo "GARAGE_ACCESS_KEY=$ACCESS_KEY"
    echo "GARAGE_SECRET_KEY=$SECRET_KEY"
    
    # Write to a file that shares volume with host or other services
    echo "GARAGE_ACCESS_KEY=$ACCESS_KEY" > /etc/garage/garage_keys.env
    echo "GARAGE_SECRET_KEY=$SECRET_KEY" >> /etc/garage/garage_keys.env
    
    # 3. 创建 Bucket
    $GARAGE_BIN bucket create supabase-storage
    $GARAGE_BIN bucket allow supabase-storage --read --write --owner --key supabase-key
    
    echo "Garage init complete."
fi

# 保持容器运行 (如果是作为 sidecar init container) 或者退出 (如果由外部调用)
# 这里假设作为 init 脚本，我们让它退出

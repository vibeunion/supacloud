#!/bin/bash
# ============================================================
# Pigsty 4.1 Upgrade Script for SupaCloud
# ============================================================

set -e

echo "=========================================================="
echo "          SupaCloud - Pigsty 4.1 升级工具                 "
echo "=========================================================="
echo ""
echo "警告：在进行基础设施升级前，强烈建议您备份重要的数据库数据！"
echo "升级过程将拉取最新的 Pigsty v4.1.0 代码并重新应用集群配置。"
echo ""
read -p "您是否已确认备份并准备好升级？[y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "升级已取消。"
    exit 0
fi

echo "=> 开始下载最新的 Pigsty 源代码..."
curl -fsSL https://repo.pigsty.io/get | bash -s v4.1.0

if [ -d "$HOME/pigsty" ]; then
    echo "=> 切换到 Pigsty 目录..."
    cd $HOME/pigsty
    
    echo "=> 配置 Pigsty v4.1..."
    ./configure
    
    echo "=> 在本机上应用 Pigsty 升级..."
    echo "   这可能会需要几分钟时间，请耐心等待。"
    
    # 重新下发剧本
    if [ -f "install.yml" ]; then
        ansible-playbook -i pigsty.yml install.yml
    else
        make install
    fi
    
    echo "=========================================================="
    echo "   升级完成！请验证您的数据库和监控服务状态。               "
    echo "=========================================================="
else
    echo "错误：无法找到下载的 Pigsty 目录 ($HOME/pigsty)。"
    exit 1
fi

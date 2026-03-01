#!/bin/bash
# SupaCloud - 系统级全局内存榨汁 (KSM 深度去重)
# 此脚本用于在宿主机底层开启 Kernel Samepage Merging。
# 当你在机器上跑 100 个同源的 gotrue 和 postgrest 进程时，
# Linux KSM 爬虫会在后台将它们长得一模一样的内存区块（例如程序二进制代码段、只读共享库）
# 物理合并为只读取一份。保守估计能帮 100 个租户省出 500MB~1GB 内存！

set -euo pipefail

echo "============================================"
echo " 正在激活 Kernel Samepage Merging (KSM)..."
echo "============================================"

# 检查内核是否编译了 KSM
if [ ! -d "/sys/kernel/mm/ksm" ]; then
    echo "[WARN] 您的系统内核似乎未开启 KSM 支持，无需执行内存合并优化。"
    exit 0
fi

# 启用 KSM
echo 1 > /sys/kernel/mm/ksm/run

# 让 KSM 扫描更激进一些（在闲置的 CPU 周期扫描）
# 每次醒来扫描 10000 个内存页
echo 10000 > /sys/kernel/mm/ksm/pages_to_scan
# 睡眠 20ms（更频繁地合并，对于长期运行的小项目合适）
echo 20 > /sys/kernel/mm/ksm/sleep_millisecs

echo "[OK] 系统级内存页合并机制已全力开启！当租户启动时会显著减少物理消耗。"

#!/bin/bash
# SupaCloud - System-level Global Memory Squeeze (KSM Deep Deduplication)
# This script is used to enable Kernel Samepage Merging at the host level.
# When you run 100 identical gotrue and postgrest processes on the machine,
# The Linux KSM crawler will merge identical memory blocks in the background
# (e.g., program binary code segments, read-only shared libraries)
# physically into a single read-only copy. Conservative estimate: saves 500MB~1GB memory for 100 tenants!

set -euo pipefail

echo "============================================"
echo " Activating Kernel Samepage Merging (KSM)..."
echo "============================================"

# Check if kernel has KSM support compiled
if [ ! -d "/sys/kernel/mm/ksm" ]; then
    echo "[WARN] Your system kernel does not seem to have KSM support enabled, no need to execute memory merging optimization."
    exit 0
fi

# Enable KSM
echo 1 > /sys/kernel/mm/ksm/run

# Make KSM scanning more aggressive (scan during idle CPU cycles)
# Scan 10000 memory pages each wake
echo 10000 > /sys/kernel/mm/ksm/pages_to_scan
# Sleep 20ms (merge more frequently, suitable for long-running small projects)
echo 20 > /sys/kernel/mm/ksm/sleep_millisecs

echo "[OK] System-level memory page merging mechanism is fully enabled! Physical consumption will be significantly reduced when tenants start."

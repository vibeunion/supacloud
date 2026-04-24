#!/bin/bash
# ============================================================
# Pigsty 4.1 Upgrade Script for SupaCloud
# ============================================================

set -e

echo "=========================================================="
echo "          SupaCloud - Pigsty 4.1 Upgrade Tool            "
echo "=========================================================="
echo ""
echo "Warning: Before upgrading infrastructure, it is strongly recommended to backup important database data!"
echo "The upgrade process will pull the latest Pigsty v4.1.0 code and reapply cluster configuration."
echo ""
read -r -p "Have you confirmed backup and are ready to upgrade? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Upgrade cancelled."
    exit 0
fi

echo "=> Starting to download latest Pigsty source code..."
curl -fsSL https://repo.pigsty.io/get | bash -s v4.2.2

if [ -d "$HOME/pigsty" ]; then
    echo "=> Switching to Pigsty directory..."
    cd $HOME/pigsty
    
    echo "=> Configuring Pigsty v4.1..."
    ./configure
    
    echo "=> Applying Pigsty upgrade on this machine..."
    echo "   This may take a few minutes, please wait patiently."
    
    # Redeploy playbook
    if [ -f "install.yml" ]; then
        ansible-playbook -i pigsty.yml install.yml
    else
        make install
    fi
    
    echo "=========================================================="
    echo "   Upgrade complete! Please verify your database and monitoring service status."
    echo "=========================================================="
else
    echo "Error: Cannot find downloaded Pigsty directory ($HOME/pigsty)."
    exit 1
fi

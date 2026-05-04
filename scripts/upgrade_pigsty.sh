#!/bin/bash
# ============================================================
# Pigsty Upgrade Script for SupaCloud
# ============================================================

set -e

echo "=========================================================="
PIGSTY_VERSION="${PIGSTY_VERSION:-v4.3.0}"
PIGSTY_CONFIG_TEMPLATE="${PIGSTY_CONFIG_TEMPLATE:-app/supa}"

echo "          SupaCloud - Pigsty Upgrade Tool                "
echo "=========================================================="
echo ""
echo "Warning: Before upgrading infrastructure, it is strongly recommended to backup important database data!"
echo "The upgrade process will pull Pigsty ${PIGSTY_VERSION} and reapply cluster configuration."
echo ""
read -r -p "Have you confirmed backup and are ready to upgrade? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Upgrade cancelled."
    exit 0
fi

echo "=> Starting to download latest Pigsty source code..."
curl -fsSL https://repo.pigsty.io/get | bash -s "${PIGSTY_VERSION}"

if [ -d "$HOME/pigsty" ]; then
    echo "=> Switching to Pigsty directory..."
    cd $HOME/pigsty
    
    echo "=> Configuring Pigsty (${PIGSTY_CONFIG_TEMPLATE} template)..."
    if ! ./configure -c "${PIGSTY_CONFIG_TEMPLATE}"; then
        echo "=> Primary template failed, trying legacy app/supa template..."
        ./configure -c app/supa || ./configure
    fi
    
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

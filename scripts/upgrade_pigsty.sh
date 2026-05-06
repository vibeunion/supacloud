#!/bin/bash
# ============================================================
# Pigsty Upgrade Script for SupaCloud
# ============================================================

set -e

echo "=========================================================="
PIGSTY_VERSION="${PIGSTY_VERSION:-v4.3.0}"
PIGSTY_CONFIG_TEMPLATE="${PIGSTY_CONFIG_TEMPLATE:-supabase}"

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
    
    # Backup existing SupaCloud customizations before configure overwrites them
    PIGSTY_YML="$HOME/pigsty/pigsty.yml"
    SUPA_BACKUP="$HOME/pigsty/pigsty.yml.supabackup.$(date +%Y%m%d%H%M%S)"
    if [[ -f "$PIGSTY_YML" ]]; then
        echo "=> Backing up current pigsty.yml to $SUPA_BACKUP"
        cp "$PIGSTY_YML" "$SUPA_BACKUP"
    fi

    echo "=> Configuring Pigsty (${PIGSTY_CONFIG_TEMPLATE} template)..."
    if ! ./configure -c "${PIGSTY_CONFIG_TEMPLATE}"; then
        echo "=> Primary template failed, trying legacy app/supa template..."
        ./configure -c app/supa || ./configure
    fi

    # Restore SupaCloud-specific patches that configure wiped out
    if [[ -f "$SUPA_BACKUP" ]]; then
        echo "=> Re-applying SupaCloud customizations from backup..."
        # Re-apply nginx_enabled: false
        if ! grep -q 'nginx_enabled: false' "$PIGSTY_YML"; then
            sed -i '/^  vars:/a\    nginx_enabled: false\n    nginx_exporter_enabled: false' "$PIGSTY_YML" || true
        fi
        # Re-apply pgbouncer tuning
        if ! grep -q 'pgbouncer_max_client_conn' "$PIGSTY_YML"; then
            sed -i '/^  vars:/a\    pgbouncer_max_client_conn: 10000\n    pgbouncer_default_pool_size: 20' "$PIGSTY_YML" || true
        fi
        # Re-apply storage type
        STORAGE_TYPE=$(grep 'S3_STORAGE_TYPE' /etc/supabase/management-api.env 2>/dev/null | cut -d= -f2 || echo "juicefs")
        if [[ "$STORAGE_TYPE" == "juicefs" ]]; then
            MOUNT=$(grep 'STORAGE_MOUNT_POINT\|STORAGE_LOCAL_ROOTPATH' /etc/supabase/management-api.env 2>/dev/null | head -1 | cut -d= -f2 || echo "/var/lib/supabase/storage")
            sed -i "s|STORAGE_BACKEND: .*|STORAGE_BACKEND: local|g" "$PIGSTY_YML" 2>/dev/null || true
        fi
        echo "=> SupaCloud customizations restored"
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

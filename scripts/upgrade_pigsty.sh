#!/bin/bash
# ============================================================
# Pigsty Upgrade Script for SupaCloud
# ============================================================

set -e

SUPACLOUD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=========================================================="
PIGSTY_VERSION="${PIGSTY_VERSION:-v4.4.0}"
PIGSTY_CONFIG_TEMPLATE="${PIGSTY_CONFIG_TEMPLATE:-supabase}"
SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK="${SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK:-false}"
ANALYTICS_WAS_RUNNING=false
ANALYTICS_PREPARE_STARTED=false
ANALYTICS_PREPARE_COMPLETED=false
UPGRADE_COMPLETED=false
ANALYTICS_COMPOSE_DIR="${PIGSTY_SUPABASE_DIR:-${HOME}/pigsty/app/supabase}"
ANALYTICS_COMPOSE_CMD=()

detect_legacy_analytics() {
    [[ -f "${ANALYTICS_COMPOSE_DIR}/docker-compose.yml" ]] || return 0
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        ANALYTICS_COMPOSE_CMD=(docker compose)
    elif command -v docker-compose >/dev/null 2>&1; then
        ANALYTICS_COMPOSE_CMD=(docker-compose)
    elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
        ANALYTICS_COMPOSE_CMD=(podman compose)
    else
        return 0
    fi
    local container_id=""
    container_id="$(cd "$ANALYTICS_COMPOSE_DIR" && "${ANALYTICS_COMPOSE_CMD[@]}" ps -q analytics 2>/dev/null || true)"
    [[ -z "$container_id" ]] || ANALYTICS_WAS_RUNNING=true
}

restore_legacy_analytics_on_failure() {
    local exit_status=$?
    if [[ "$exit_status" -ne 0 && "$ANALYTICS_PREPARE_STARTED" == "true" && "$ANALYTICS_PREPARE_COMPLETED" != "true" ]]; then
        # The compatibility script owns failure recovery while prepare is running.
        return "$exit_status"
    fi
    if [[ "$exit_status" -ne 0 && "$UPGRADE_COMPLETED" != "true" && "$ANALYTICS_PREPARE_COMPLETED" == "true" && "$ANALYTICS_WAS_RUNNING" == "true" && ${#ANALYTICS_COMPOSE_CMD[@]} -gt 0 ]]; then
        echo "=> Upgrade failed; recreating Analytics with the current environment..." >&2
        (cd "$ANALYTICS_COMPOSE_DIR" && "${ANALYTICS_COMPOSE_CMD[@]}" up -d --force-recreate analytics) || true
    fi
    return "$exit_status"
}

detect_legacy_analytics
trap restore_legacy_analytics_on_failure EXIT

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

if [[ -f "${SUPACLOUD_ROOT}/scripts/upgrade_pigsty_4_4_compat.sh" ]]; then
    echo "=> Preparing Analytics migration before Pigsty 4.4 services can initialize the destination schema..."
    ANALYTICS_PREPARE_STARTED=true
    bash "${SUPACLOUD_ROOT}/scripts/upgrade_pigsty_4_4_compat.sh" --prepare-analytics
    ANALYTICS_PREPARE_COMPLETED=true
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
        if [[ "$SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK" == "true" ]]; then
            echo "=> Primary template failed, trying legacy app/supa template..."
            ./configure -c app/supa || ./configure
        else
            echo "=> Primary template failed, falling back to Pigsty default template..."
            ./configure
        fi
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
        if [[ "$SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK" != "true" ]]; then
            echo "=> Keeping Pigsty nginx/certbot disabled; SupaCloud owns HTTP(S) through Caddy"
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

    if [[ -f "${SUPACLOUD_ROOT}/scripts/upgrade_pigsty_4_4_compat.sh" ]]; then
        echo "=> Applying Pigsty 4.4 Supabase compatibility migrations..."
        bash "${SUPACLOUD_ROOT}/scripts/upgrade_pigsty_4_4_compat.sh" --apply
    fi
    
    echo "=========================================================="
    echo "   Upgrade complete! Please verify your database and monitoring service status."
    echo "=========================================================="
    UPGRADE_COMPLETED=true
else
    echo "Error: Cannot find downloaded Pigsty directory ($HOME/pigsty)."
    exit 1
fi

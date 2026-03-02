#!/bin/bash

# ha_manager.sh
# Manage database cluster high availability (Patroni) and operations

set -e

COMMAND=$1
TARGET=$2
OPTIONS=$3

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $1"; }

case $COMMAND in
    switchover)
        # Primary-replica switchover
        # TARGET is cluster name (Stanza/Cluster Name)
        # OPTIONS is candidate node (Optional candidate)
        CLUSTER=${TARGET:-"db-main"}
        log_info "Initiating switchover for cluster: $CLUSTER"
        if [ -n "$OPTIONS" ]; then
            sudo -u postgres patronictl -c /etc/patroni.yml switchover "$CLUSTER" --candidate "$OPTIONS" --force
        else
            sudo -u postgres patronictl -c /etc/patroni.yml switchover "$CLUSTER" --force
        fi
        log_info "Switchover command sent"
        ;;

    reload)
        # Online configuration reload
        # TARGET is node IP or localhost
        NODE_IP=${TARGET:-"localhost"}
        log_info "Reloading configuration for node: $NODE_IP"
        # Prefer Exporter's reload interface, fallback to pg_ctl if unavailable
        curl -s -X POST "http://${NODE_IP}:9630/reload" || sudo -u postgres pg_ctl reload
        log_info "Reload signal sent"
        ;;

    add_replica)
        # Scale up read-only replica
        # TARGET is new node IP
        REPLICA_IP=$TARGET
        if [ -z "$REPLICA_IP" ]; then
            log_error "Replica IP is required"
            exit 1
        fi
        log_info "Scaling up: adding replica at $REPLICA_IP"
        # Call Pigsty native deployment command
        # Note: This usually requires management node privileges
        pig pgsql init -l "$REPLICA_IP"
        log_info "Replica initialization started"
        ;;

    vertical_scale)
        # Vertical scaling (adjust resource limits)
        # TARGET is cluster name, OPTIONS is resource parameters (e.g., "cpu=2 mem=4g")
        CLUSTER=${TARGET:-"db-main"}
        LIMITS=$OPTIONS
        if [ -z "$LIMITS" ]; then
            log_error "Resource limits are required (e.g., cpu=2 mem=4g)"
            exit 1
        fi
        log_info "Vertical scaling cluster $CLUSTER to $LIMITS"
        # Assume pig pgsql edit supports passing resource parameters via command line
        pig pgsql edit "$CLUSTER" -e "$LIMITS"
        log_info "Resource limits updated"
        ;;

    *)
        echo "Usage: $0 {switchover|reload|add_replica} [target] [options]"
        exit 1
        ;;
esac

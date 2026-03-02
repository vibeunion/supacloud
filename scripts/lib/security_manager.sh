#!/bin/bash

# security_manager.sh
# Manage firewall rules and SSL certificate requests (ACME)

set -e

COMMAND=$1
TARGET=$2
OPTIONS=$3

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $1"; }

case $COMMAND in
    add_firewall_rule)
        # Add firewall rule
        # TARGET is port, OPTIONS is source IP
        PORT=$TARGET
        SOURCE_IP=$OPTIONS
        if [ -z "$PORT" ] || [ -z "$SOURCE_IP" ]; then
            log_error "Port and Source IP are required"
            exit 1
        fi
        log_info "Adding firewall rule: Allow $SOURCE_IP on port $PORT"
        # Simple implementation: call iptables directly. Production environment recommended to manage via Pigsty role.
        sudo iptables -I INPUT -p tcp -s "$SOURCE_IP" --dport "$PORT" -j ACCEPT
        log_info "Rule added successfully"
        ;;

    remove_firewall_rule)
        # Remove firewall rule
        PORT=$TARGET
        SOURCE_IP=$OPTIONS
        log_info "Removing firewall rule: Allow $SOURCE_IP on port $PORT"
        sudo iptables -D INPUT -p tcp -s "$SOURCE_IP" --dport "$PORT" -j ACCEPT || true
        log_info "Rule removed"
        ;;

    deploy_certificate)
        # Trigger SSL certificate request (ACME)
        # TARGET is domain name
        DOMAIN=$TARGET
        if [ -z "$DOMAIN" ]; then
            log_error "Domain name is required"
            exit 1
        fi
        log_info "Initiating SSL certificate request for: $DOMAIN"
        # Call Pigsty's built-in acme role or script
        # Assume Pigsty provides a wrapped script or we can run playbook directly
        cd ~/pigsty && ./nodes.yml -t node_cert -e "node_certs=[{name: $DOMAIN}]"
        log_info "Certificate deployment task started"
        ;;

    *)
        echo "Usage: $0 {add_firewall_rule|remove_firewall_rule|deploy_certificate} [target] [options]"
        exit 1
        ;;
esac

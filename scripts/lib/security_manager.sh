#!/bin/bash

# security_manager.sh
# 管理防火墙规则与 SSL 证书申请 (ACME)

set -e

COMMAND=$1
TARGET=$2
OPTIONS=$3

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $1"; }

case $COMMAND in
    add_firewall_rule)
        # 添加防火墙规则
        # TARGET 为端口, OPTIONS 为来源 IP
        PORT=$TARGET
        SOURCE_IP=$OPTIONS
        if [ -z "$PORT" ] || [ -z "$SOURCE_IP" ]; then
            log_error "Port and Source IP are required"
            exit 1
        fi
        log_info "Adding firewall rule: Allow $SOURCE_IP on port $PORT"
        # 简单实现：直接调用 iptables。生产环境建议通过 Pigsty 角色管理。
        sudo iptables -I INPUT -p tcp -s "$SOURCE_IP" --dport "$PORT" -j ACCEPT
        log_info "Rule added successfully"
        ;;

    remove_firewall_rule)
        # 删除防火墙规则
        PORT=$TARGET
        SOURCE_IP=$OPTIONS
        log_info "Removing firewall rule: Allow $SOURCE_IP on port $PORT"
        sudo iptables -D INPUT -p tcp -s "$SOURCE_IP" --dport "$PORT" -j ACCEPT || true
        log_info "Rule removed"
        ;;

    deploy_certificate)
        # 触发 SSL 证书申请 (ACME)
        # TARGET 为域名
        DOMAIN=$TARGET
        if [ -z "$DOMAIN" ]; then
            log_error "Domain name is required"
            exit 1
        fi
        log_info "Initiating SSL certificate request for: $DOMAIN"
        # 调用 Pigsty 内置的 acme 角色或脚本
        # 假设 Pigsty 提供了一个封装好的脚本或我们可以直接运行 playbook
        cd ~/pigsty && ./nodes.yml -t node_cert -e "node_certs=[{name: $DOMAIN}]"
        log_info "Certificate deployment task started"
        ;;

    *)
        echo "Usage: $0 {add_firewall_rule|remove_firewall_rule|deploy_certificate} [target] [options]"
        exit 1
        ;;
esac

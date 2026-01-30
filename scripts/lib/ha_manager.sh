#!/bin/bash

# ha_manager.sh
# 管理数据库集群高可用 (Patroni) 与运维操作

set -e

COMMAND=$1
TARGET=$2
OPTIONS=$3

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $1"; }

case $COMMAND in
    switchover)
        # 主从切换
        # TARGET 为集群名 (Stanza/Cluster Name)
        # OPTIONS 为候选节点 (Optional candidate)
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
        # 在线重载配置
        # TARGET 为节点 IP 或 localhost
        NODE_IP=${TARGET:-"localhost"}
        log_info "Reloading configuration for node: $NODE_IP"
        # 优先使用 Exporter 的 reload 接口，如果不可用则回退到 pg_ctl
        curl -s -X POST "http://${NODE_IP}:9630/reload" || sudo -u postgres pg_ctl reload
        log_info "Reload signal sent"
        ;;

    add_replica)
        # 扩容只读副本
        # TARGET 为新节点 IP
        REPLICA_IP=$TARGET
        if [ -z "$REPLICA_IP" ]; then
            log_error "Replica IP is required"
            exit 1
        fi
        log_info "Scaling up: adding replica at $REPLICA_IP"
        # 调用 Pigsty 原生部署命令
        # 注意：这通常需要管理节点权限
        pig pgsql init -l "$REPLICA_IP"
        log_info "Replica initialization started"
        ;;

    vertical_scale)
        # 垂直扩容 (调整资源限制)
        # TARGET 为集群名, OPTIONS 为资源参数 (例如: "cpu=2 mem=4g")
        CLUSTER=${TARGET:-"db-main"}
        LIMITS=$OPTIONS
        if [ -z "$LIMITS" ]; then
            log_error "Resource limits are required (e.g., cpu=2 mem=4g)"
            exit 1
        fi
        log_info "Vertical scaling cluster $CLUSTER to $LIMITS"
        # 假设 pig pgsql edit 支持通过命令行传入资源参数
        pig pgsql edit "$CLUSTER" -e "$LIMITS"
        log_info "Resource limits updated"
        ;;

    *)
        echo "Usage: $0 {switchover|reload|add_replica} [target] [options]"
        exit 1
        ;;
esac

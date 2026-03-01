import * as p from "@clack/prompts";
import { ClusterManager } from "./infra/cluster";

/**
 * 运行数据库集群管理 CLI
 */
export async function runClusterManager() {
    p.intro("SupaCloud 数据库集群管理 (HA)");

    const action = await p.select({
        message: "请选择集群操作:",
        options: [
            { value: "status", label: "查看集群状态", hint: "Patroni 拓扑与延迟" },
            { value: "failover", label: "触发主从切换", hint: "Failover / Switchover" },
            { value: "back", label: "返回" },
        ],
    });

    if (action === "back" || p.isCancel(action)) return;

    if (action === "status") {
        const nodes = await ClusterManager.getStatus();
        if (nodes.length === 0) {
            p.log.warn("未能获取到集群状态。请确认 Patroni 是否已安装且运行。");
        } else {
            console.table(nodes);
        }
    }

    if (action === "failover") {
        const nodes = await ClusterManager.getStatus();
        const replicas = nodes.filter(n => n.role !== "Leader" && n.state === "running");

        if (replicas.length === 0) {
            p.log.error("没有可用的备库节点用于切换！");
            return await runClusterManager();
        }

        const confirmed = await p.confirm({
            message: "确定要执行数据库主从切换吗？这可能会导致短暂的连接波动。",
        });

        if (confirmed) {
            const s = p.spinner();
            s.start("正在下发切换指令...");
            const result = await ClusterManager.failover();
            s.stop("操作完成");
            if (result.success) {
                p.log.success(result.message);
            } else {
                p.log.error(result.message);
            }
        }
    }

    await runClusterManager();
}

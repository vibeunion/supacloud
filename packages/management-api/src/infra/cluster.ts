import { $ } from "bun";

export interface ClusterNode {
    member: string;
    host: string;
    role: "Leader" | "Replica" | "Sync Standby";
    state: string;
    lag: string;
}

/**
 * Patroni 数据库集群管理器
 * 解析 patronictl 输出，提供切换、健康检查等核心功能
 */
export class ClusterManager {
    /**
     * 获取集群拓扑状态
     */
    static async getStatus(): Promise<ClusterNode[]> {
        try {
            // 这里的 cluster 名称通常在 pigsty.yml 中定义，默认 pg-test
            const output = await $`patronictl -c /etc/patroni/patroni.yml list -f json`.text();
            return JSON.parse(output);
        } catch (e) {
            // 如果没有 patroni.yml，尝试直接执行 (依赖环境路径)
            try {
                const output = await $`patronictl list -f json`.text();
                return JSON.parse(output);
            } catch (err) {
                console.error("[Cluster] 无法获取 Patroni 集群状态:", err);
                return [];
            }
        }
    }

    /**
     * 执行手动主从切换 (Failover)
     * @param candidate 目标主库成员名 (可选)
     */
    static async failover(candidate?: string): Promise<{ success: boolean; message: string }> {
        console.log(`[Cluster] 正在触发集群切换... 候选者: ${candidate || "自动选择"}`);
        try {
            const cmd = candidate
                ? `patronictl failover --force --candidate ${candidate}`
                : `patronictl failover --force`;

            const result = await $`bash -c "${cmd}"`.nothrow();
            if (result.exitCode === 0) {
                return { success: true, message: "切换指令已下发，请关注集群节点状态变化。" };
            }
            return { success: false, message: `切换失败: ${result.stderr.toString()}` };
        } catch (e: any) {
            return { success: false, message: e.message };
        }
    }

    /**
     * 暂停/恢复集群自动故障转移 (Maintenance Mode)
     */
    static async setPause(paused: boolean): Promise<void> {
        const action = paused ? "pause" : "resume";
        await $`patronictl ${action} --force`.nothrow();
    }
}

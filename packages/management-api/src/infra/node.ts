import { $ } from "bun";

export interface NodeInfo {
    ip: string;
    hostname: string;
    role: "pg" | "app" | "db" | "lb";
    status: "online" | "offline" | "unknown";
    createdAt: number;
}

/**
 * 集群节点管理器
 * 负责多机互信、状态拨测以及 Pigsty 节点定义维护
 */
export class NodeManager {
    private static readonly NODE_DB_PATH = "/etc/supabase/nodes.json";

    /**
     * 获取所有节点列表
     */
    static async listNodes(): Promise<NodeInfo[]> {
        const file = Bun.file(this.NODE_DB_PATH);
        if (!(await file.exists())) return [];
        try {
            const data = await file.text();
            return JSON.parse(data);
        } catch (e) {
            return [];
        }
    }

    /**
     * 添加新节点并配置互信
     */
    static async addNode(ip: string, user: string, pass: string, role: string): Promise<NodeInfo> {
        console.log(`[Node] 正在准备添加节点: ${ip} (${role})...`);

        // 1. 配置 SSH 互信 (使用 ssh-copy-id 模拟，或直接写入密钥)
        // 注意: 实际执行中建议先检测能否免密联通
        try {
            const pubKeyPath = `${process.env.HOME}/.ssh/id_rsa.pub`;
            if (!(await Bun.file(pubKeyPath).exists())) {
                console.log("[Node] 生成管理节点 SSH 密钥对...");
                await $`ssh-keygen -t rsa -N "" -f ${process.env.HOME}/.ssh/id_rsa`.quiet();
            }

            console.log(`[Node] 分发 SSH 密钥至 ${ip}...`);
            // 使用 sshpass (如果安装了) 或 手动注入
            await $`sshpass -p "${pass}" ssh-copy-id -o StrictHostKeyChecking=no ${user}@${ip}`.quiet();
        } catch (error) {
            throw new Error(`无法通过 SSH 建立互信: ${error}`);
        }

        // 2. 获取目标主机名
        const hostname = (await $`ssh ${ip} "hostname"`.text()).trim();

        const newNode: NodeInfo = {
            ip,
            hostname,
            role: role as any,
            status: "online",
            createdAt: Date.now(),
        };

        // 3. 保存至元数据层
        const nodes = await this.listNodes();
        nodes.push(newNode);
        await Bun.write(this.NODE_DB_PATH, JSON.stringify(nodes, null, 2));

        return newNode;
    }

    /**
     * 检测所有节点健康状态
     */
    static async pingAll(): Promise<void> {
        const nodes = await this.listNodes();
        for (const node of nodes) {
            const isOnline = (await $`ping -c 1 -W 1 ${node.ip}`.nothrow()).exitCode === 0;
            node.status = isOnline ? "online" : "offline";
        }
        await Bun.write(this.NODE_DB_PATH, JSON.stringify(nodes, null, 2));
    }
}

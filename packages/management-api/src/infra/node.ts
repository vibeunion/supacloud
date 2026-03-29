import { $ } from "bun";
import { logger } from "../utils/logger";
import { config } from "../config";

export interface NodeInfo {
    ip: string;
    hostname: string;
    role: "pg" | "app" | "db" | "lb";
    status: "online" | "offline" | "unknown";
    createdAt: number;
}

/**
 * Cluster Node Manager
 * Responsible for multi-node trust establishment, health checks, and Pigsty node definition maintenance
 */
export class NodeManager {
    private static readonly NODE_DB_PATH = "/etc/supabase/nodes.json";

    /**
     * Get all nodes list
     */
    static async listNodes(): Promise<NodeInfo[]> {
        const file = Bun.file(this.NODE_DB_PATH);
        if (!(await file.exists())) return [];
        try {
            const data = await file.text();
            return JSON.parse(data);
        } catch (e: unknown) {
            return [];
        }
    }

    /**
     * Add new node and configure trust
     */
    static async addNode(ip: string, user: string, pass: string, role: string): Promise<NodeInfo> {
        logger.info(`[Node] Preparing to add node: ${ip} (${role})...`);

        // 1. Configure SSH trust (using ssh-copy-id simulation, or write key directly)
        // Note: In actual execution, it's recommended to check if passwordless connection works first
        try {
            const pubKeyPath = `${config.homePath}/.ssh/id_rsa.pub`;
            if (!(await Bun.file(pubKeyPath).exists())) {
                logger.info("[Node] Generating management node SSH key pair...");
                await $`ssh-keygen -t rsa -N "" -f ${config.homePath}/.ssh/id_rsa`.quiet();
            }

            logger.info(`[Node] Distributing SSH key to ${ip}...`);
            // Use sshpass (if installed) or manual injection
            await $`sshpass -p "${pass}" ssh-copy-id -o StrictHostKeyChecking=no ${user}@${ip}`.quiet();
        } catch (error: unknown) {
            throw new Error(`Failed to establish SSH trust: ${error}`);
        }

        // 2. Get target hostname
        const hostname = (await $`ssh ${ip} "hostname"`.text()).trim();

        const newNode: NodeInfo = {
            ip,
            hostname,
            role: role as "db" | "app" | "pg" | "lb",
            status: "online",
            createdAt: Date.now(),
        };

        // 3. Save to metadata layer
        const nodes = await this.listNodes();
        nodes.push(newNode);
        await Bun.write(this.NODE_DB_PATH, JSON.stringify(nodes, null, 2));

        return newNode;
    }

    /**
     * Check all nodes health status
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

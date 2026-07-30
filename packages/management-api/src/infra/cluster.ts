import { $ } from "bun";
import { logger } from "../utils/logger";

export const PATRONI_CONFIG_PATH = "/etc/patroni/patroni.yml";

export interface ClusterNode {
    role: string;
    state: string;
    member: string;
}

export function patronictlListArguments(hasPatroniConfig: boolean): string[] {
    return hasPatroniConfig
        ? ["-c", PATRONI_CONFIG_PATH, "list", "--format", "json"]
        : ["list", "--format", "json"];
}

export function parsePatroniNodes(commandOutput: string): ClusterNode[] {
    const output = commandOutput.trim();
    // patronictl exits successfully with no stdout when it cannot resolve a cluster name.
    if (!output) return [];
    const nodes = JSON.parse(output);
    return Array.isArray(nodes) ? nodes.map((node: Record<string, string>) => ({
        role: node.Role || node.role || "unknown",
        state: node.State || node.state || "unknown",
        member: node.Member || node.member || "unknown",
    })) : [];
}

export class ClusterManager {
    /**
     * Get cluster status via patronictl (if available)
     * Returns empty array if Patroni is not installed/running
     */
    static async getStatus(): Promise<ClusterNode[]> {
        try {
            const commandArguments = patronictlListArguments(await Bun.file(PATRONI_CONFIG_PATH).exists());
            const result = await $`patronictl ${commandArguments}`.nothrow().quiet();
            if (result.exitCode !== 0) return [];
            return parsePatroniNodes(result.stdout.toString());
        } catch (err: unknown) {
            logger.debug("[ClusterManager] Patroni not available, skipping HA detection", {
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    }
}

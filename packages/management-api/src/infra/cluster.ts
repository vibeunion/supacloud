/**
 * Stub module for the planned cluster module.
 * The actual implementation will be added when HA cluster support is built.
 * Currently returns empty arrays so health checks can proceed gracefully.
 */
import { $ } from "bun";
import { logger } from "../utils/logger";

export interface ClusterNode {
    role: string;
    state: string;
    member: string;
}

export class ClusterManager {
    /**
     * Get cluster status via patronictl (if available)
     * Returns empty array if Patroni is not installed/running
     */
    static async getStatus(): Promise<ClusterNode[]> {
        try {
            const result = await $`patronictl list --format json`.nothrow().quiet();
            if (result.exitCode !== 0) return [];
            const data = JSON.parse(result.stdout.toString());
            return Array.isArray(data) ? data.map((n: Record<string, string>) => ({
                role: n.Role || n.role || "unknown",
                state: n.State || n.state || "unknown",
                member: n.Member || n.member || "unknown",
            })) : [];
        } catch (err: unknown) {
            logger.debug("[ClusterManager] Patroni not available, skipping HA detection", {
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    }
}

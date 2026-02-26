import { HealthStatus, NodeMetrics } from '../types/monitor';
import { config } from '../config';

export class MonitorService {
    /**
     * 获取数据库实例的健康状态
     * @param nodeIp 数据库节点 IP
     * @param port PG Exporter 端口，默认 9630
     */
    static async getHealth(nodeIp: string, port: number = 9630): Promise<HealthStatus> {
        const url = `http://${nodeIp}:${port}/health`;
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
            if (!response.ok) throw new Error('Exporter returned non-OK status');

            const data = await response.json();
            // 假设 Pigsty Exporter 返回结构包含 status 和 role
            return {
                status: data.status === 'ok' ? 'up' : 'down',
                role: data.role || 'unknown',
                node: nodeIp,
                timestamp: new Date().toISOString(),
            };
        } catch (error) {
            console.error(`Health check failed for ${nodeIp}:`, error);
            return {
                status: 'unreachable',
                role: 'unknown',
                node: nodeIp,
                timestamp: new Date().toISOString(),
            };
        }
    }

    /**
     * 从 VictoriaMetrics 获取核心指标
     * @param nodeIp 节点 IP
     */
    static async getMetrics(nodeIp: string): Promise<NodeMetrics> {
        const vmUrl = process.env.VICTORIAMETRICS_URL || `http://${nodeIp}:8428`;

        const queries = {
            qps: `sum(rate(pg_stat_database_xact_commit{instance=~"${nodeIp}:.*"}[5m]))`,
            connections: `sum(pg_stat_activity_count{instance=~"${nodeIp}:.*"})`,
            slow_queries: `sum(pg_slow_queries_count{instance=~"${nodeIp}:.*"})`,
            cpu_usage: `sum(rate(node_cpu_seconds_total{mode!="idle",instance=~"${nodeIp}:.*"}[5m])) / count(node_cpu_seconds_total{mode="idle",instance=~"${nodeIp}:.*"}) * 100`,
            mem_usage: `(node_memory_MemTotal_bytes{instance=~"${nodeIp}:.*"} - node_memory_MemAvailable_bytes{instance=~"${nodeIp}:.*"}) / node_memory_MemTotal_bytes{instance=~"${nodeIp}:.*"} * 100`,
        };

        try {
            const results = await Promise.all(
                Object.entries(queries).map(async ([key, query]) => {
                    const response = await fetch(`${vmUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
                    const data = await response.json();
                    const value = data.data?.result?.[0]?.value?.[1] || 0;
                    return [key, parseFloat(value)];
                })
            );

            const metricsMap = Object.fromEntries(results);
            return {
                qps: metricsMap.qps,
                active_connections: metricsMap.connections,
                slow_queries: metricsMap.slow_queries,
                cpu_usage: metricsMap.cpu_usage,
                mem_usage: metricsMap.mem_usage,
            };
        } catch (error) {
            console.error('Failed to fetch metrics from VictoriaMetrics:', error);
            return { qps: 0, active_connections: 0, slow_queries: 0 };
        }
    }
}

import type { HealthStatus, NodeMetrics } from '../types/monitor';
import { logger } from "../utils/logger";
import { config } from '../config';

const MONITOR_ALLOWED_HOSTS = new Set(
  [
    config.dockerHostIp,
    config.pgHost,
    "127.0.0.1",
    "localhost",
    ...(process.env.MONITOR_ALLOWED_HOSTS?.split(",") || []),
    ...((process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") ? ["1.2.3.4"] : []),
  ]
    .map((host) => host.trim())
    .filter(Boolean),
);

function assertAllowedMonitorHost(nodeIp: string): void {
  if (!/^[a-zA-Z0-9.-]+$/.test(nodeIp) || !MONITOR_ALLOWED_HOSTS.has(nodeIp)) {
    throw new Error("Monitor target is not allowed");
  }
}

/**
 * Get database instance health status
 * @param nodeIp Database node IP
 * @param port PG Exporter port, defaults to 9630
 */
export async function getHealth(nodeIp: string, port: number = 9630): Promise<HealthStatus> {
  try {
    assertAllowedMonitorHost(nodeIp);
    const url = `http://${nodeIp}:${port}/health`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Exporter returned non-OK status');

    const data = await response.json();
    return {
      status: data.status === 'ok' ? 'up' : 'down',
      role: data.role || 'unknown',
      node: nodeIp,
      timestamp: new Date().toISOString(),
    };
  } catch (error: unknown) {
    logger.error(`Health check failed for ${nodeIp}:`, { error: error instanceof Error ? error.message : String(error) });
    return {
      status: 'unreachable',
      role: 'unknown',
      node: nodeIp,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Get core metrics from VictoriaMetrics
 * @param nodeIp Node IP
 */
export async function getMetrics(nodeIp: string): Promise<NodeMetrics> {
  try {
    assertAllowedMonitorHost(nodeIp);
  } catch (error: unknown) {
    logger.error('Rejected monitor metrics target:', { error: error instanceof Error ? error.message : String(error) });
    return { qps: 0, active_connections: 0, slow_queries: 0 };
  }

  const vmUrl = config.victoriaMetricsUrl || `http://${nodeIp}:8428`;

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
  } catch (error: unknown) {
    logger.error('Failed to fetch metrics from VictoriaMetrics:', { error: error instanceof Error ? error.message : String(error) });
    return { qps: 0, active_connections: 0, slow_queries: 0 };
  }
}

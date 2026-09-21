export function overviewFixture(projectRef = "a") {
  return {
    project_ref: projectRef,
    database: { size: "12 MB", cache_hit_ratio: null, connections: 2, max_connections: 100, table_count: 1, index_count: 2 },
    auth: { source: "local", managed_by_ref: null, total_users: 0, recent_users: [] },
    storage: { size: "0 bytes" }, functions: { count: 0 },
    tasks: { running: 0, retryScheduled: 0, deadLettered: 0, failedLast24h: 0, cancelledLast24h: 0, topFailures: [], failedTrend: [] },
    active_queries: [],
  };
}

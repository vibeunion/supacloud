export interface AdvisorPayload {
  error_rates: Array<{
    service: string; observations: number; errors: number; error_rate: number | null;
    status: "ok" | "warning" | "unknown"; reason?: string;
  }>;
  database: {
    available: boolean; reason?: string;
    connections: { active: number | null; max: number | null };
    blocked_sessions: number | null; unused_indexes: number | null;
    tables_without_rls: Array<{ schema: string; table: string }>;
    forced_rls_tables: Array<{ schema: string; table: string }>;
  };
  edge_functions: { count: number | null; available: boolean; reason?: string };
}
export interface ConnectionRow {
  pid: number; role: string; application: string; state: string | null;
  wait_event_type: string | null; wait_event: string | null;
  query_started_at: string | null; blocking_pids: number[];
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nullableCount(value: unknown): number | null {
  if (value === null || count(value)) return value;
  throw new Error("顾问数据格式无效");
}
function text(value: unknown): string | null {
  if (typeof value === "string" || value === null) return value;
  throw new Error("连接观测数据格式无效");
}
function tables(value: unknown): Array<{ schema: string; table: string }> {
  if (!Array.isArray(value)) throw new Error("顾问数据格式无效");
  return value.map(row => {
    if (!record(row) || typeof row.schema !== "string" || typeof row.table !== "string") throw new Error("顾问数据格式无效");
    return { schema: row.schema, table: row.table };
  });
}
export function decodeAdvisorPayload(value: unknown, ref: string): AdvisorPayload {
  if (!record(value) || value.project_ref !== ref || value.schema !== "supacloud.project-advisors.v1"
    || !Array.isArray(value.error_rates) || value.error_rates.length !== 4 || !record(value.database)
    || !record(value.database.connections) || !record(value.edge_functions)) throw new Error("顾问数据格式无效");
  const services = new Set(["data_api", "auth", "storage", "edge_functions"]);
  const error_rates: AdvisorPayload["error_rates"] = value.error_rates.map(item => {
    if (!record(item) || typeof item.service !== "string" || !services.delete(item.service)
      || !count(item.observations) || !count(item.errors) || item.errors > item.observations
      || !["ok", "warning", "unknown"].includes(String(item.status))
      || (item.error_rate !== null && (typeof item.error_rate !== "number" || !Number.isFinite(item.error_rate)
        || item.error_rate < 0 || item.error_rate > 1))
      || (item.error_rate === null && item.status !== "unknown")
      || (item.observations === 0 && item.error_rate !== null)) throw new Error("顾问数据格式无效");
    if (item.status !== "ok" && item.status !== "warning" && item.status !== "unknown") throw new Error("顾问数据格式无效");
    return { service: item.service, observations: item.observations, errors: item.errors,
      error_rate: typeof item.error_rate === "number" ? item.error_rate : null, status: item.status,
      ...(typeof item.reason === "string" ? { reason: item.reason } : {}) };
  });
  const db = value.database;
  const edge = value.edge_functions;
  if (!record(db.connections) || typeof db.available !== "boolean" || typeof edge.available !== "boolean") throw new Error("顾问数据格式无效");
  const active = nullableCount(db.connections.active);
  const max = nullableCount(db.connections.max);
  const blocked = nullableCount(db.blocked_sessions);
  const unused = nullableCount(db.unused_indexes);
  const edgeCount = nullableCount(edge.count);
  if ((db.available && (active === null || max === null || max === 0 || blocked === null || unused === null))
    || (!db.available && [active, max, blocked, unused].some(v => v !== null))
    || (edge.available !== (edgeCount !== null))) throw new Error("顾问数据格式无效");
  return { error_rates, database: { available: db.available, connections: { active, max },
    blocked_sessions: blocked, unused_indexes: unused, tables_without_rls: tables(db.tables_without_rls),
    forced_rls_tables: tables(db.forced_rls_tables), ...(typeof db.reason === "string" ? { reason: db.reason } : {}) },
    edge_functions: { available: edge.available, count: edgeCount, ...(typeof edge.reason === "string" ? { reason: edge.reason } : {}) } };
}
export function decodeConnectionRows(value: unknown, ref: string): { rows: ConnectionRow[]; truncated: boolean } {
  if (!record(value) || value.project_ref !== ref || !Array.isArray(value.rows) || value.rows.length > 100
    || typeof value.truncated !== "boolean") throw new Error("连接观测数据格式无效");
  return { truncated: value.truncated, rows: value.rows.map(row => {
    if (!record(row) || !count(row.pid) || row.pid === 0 || typeof row.role !== "string" || typeof row.application !== "string"
      || !Array.isArray(row.blocking_pids) || !row.blocking_pids.every(pid => count(pid) && pid > 0)) throw new Error("连接观测数据格式无效");
    return { pid: row.pid, role: row.role, application: row.application, state: text(row.state),
      wait_event_type: text(row.wait_event_type), wait_event: text(row.wait_event),
      query_started_at: text(row.query_started_at), blocking_pids: row.blocking_pids };
  }) };
}

import { requestValidatedJson } from "./validated-json";

function invalid(): never { throw new Error("Invalid project overview response"); }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : invalid();
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}
function text(value: unknown): string {
  return typeof value === "string" ? value : invalid();
}
function nonempty(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : invalid();
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
function array<T>(value: unknown, parse: (value: unknown) => T, max: number): T[] {
  return Array.isArray(value) && value.length <= max ? value.map(parse) : invalid();
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) return invalid();
  return result;
}
function size(value: unknown): string {
  const result = text(value);
  return /^(?:0|[1-9]\d*) (?:bytes|kB|MB|GB|TB|PB)$/.test(result) ? result : invalid();
}
function ratio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : invalid();
}
export function validOverviewProject(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function taskStats(value: unknown) {
  const row = record(value);
  const messages = new Set<string>();
  const buckets = new Set<string>();
  return {
    running: count(row.running), retryScheduled: count(row.retryScheduled), deadLettered: count(row.deadLettered),
    failedLast24h: count(row.failedLast24h), cancelledLast24h: count(row.cancelledLast24h),
    topFailures: array(row.topFailures, value => {
      const item = record(value);
      const message = nonempty(item.message);
      if (messages.has(message)) return invalid();
      messages.add(message);
      return { message, count: count(item.count) };
    }, 5),
    failedTrend: array(row.failedTrend, value => {
      const item = record(value);
      const bucket = text(item.bucket);
      if (!/^(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):00$/.test(bucket)
        || buckets.has(bucket)) return invalid();
      buckets.add(bucket);
      return { bucket, failures: count(item.failures) };
    }, 25),
  };
}
export function parseProjectOverview(value: unknown, projectRef: string) {
  const row = record(value);
  if (!validOverviewProject(projectRef) || row.project_ref !== projectRef) return invalid();
  const database = nullable(row.database, value => {
    const db = record(value);
    const maximum = count(db.max_connections);
    if (maximum === 0) return invalid();
    return {
      size: size(db.size), cache_hit_ratio: nullable(db.cache_hit_ratio, ratio),
      connections: count(db.connections), max_connections: maximum,
      table_count: count(db.table_count), index_count: count(db.index_count),
    };
  });
  const auth = record(row.auth);
  const source = auth.source;
  if (source !== "local" && source !== "supauth" && source !== "external") return invalid();
  const owner = auth.managed_by_ref;
  if (source === "supauth" ? !validOverviewProject(owner) || owner === projectRef : owner !== null) return invalid();
  if (source !== "local" && (auth.total_users !== null || auth.recent_users !== null)) return invalid();
  const userIds = new Set<string>();
  const recentUsers = nullable(auth.recent_users, value => array(value, value => {
    const user = record(value);
    const id = nonempty(user.id);
    if (userIds.has(id)) return invalid();
    userIds.add(id);
    return { id, email: nullable(user.email, text), created_at: timestamp(user.created_at) };
  }, 5));
  const queryIds = new Set<number>();
  return {
    project_ref: projectRef, database,
    auth: { source, managed_by_ref: nullable(owner, nonempty), total_users: nullable(auth.total_users, count), recent_users: recentUsers },
    storage: nullable(row.storage, value => ({ size: size(record(value).size) })),
    functions: nullable(row.functions, value => ({ count: count(record(value).count) })),
    tasks: nullable(row.tasks, taskStats),
    active_queries: nullable(row.active_queries, value => array(value, value => {
      const query = record(value);
      const pid = count(query.pid);
      if (pid === 0 || queryIds.has(pid) || query.state !== "active") return invalid();
      queryIds.add(pid);
      return { pid, usename: nullable(query.usename, nonempty), query: text(query.query) };
    }, 5)),
  };
}
export type ProjectOverview = ReturnType<typeof parseProjectOverview>;
export function loadProjectOverview(
  projectRef: string, request: (url: string, options: RequestInit) => Promise<Response>, signal: AbortSignal,
): Promise<ProjectOverview> {
  if (!validOverviewProject(projectRef)) throw new Error("Missing project overview identity");
  return requestValidatedJson(`/v1/projects/${projectRef}/dashboard/summary`, request,
    value => parseProjectOverview(value, projectRef), { signal, cache: "no-store" }, { maxBytes: 512 * 1024 });
}

import { statisticsCount } from "../utils/task-statistics";

function invalid(): never { throw new Error("Invalid project dashboard data"); }
export function dashboardRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : invalid();
}
export function dashboardRows(value: unknown, max = 5): Record<string, unknown>[] {
  return Array.isArray(value) && value.length <= max ? value.map(dashboardRecord) : invalid();
}
export function dashboardRow(value: unknown): Record<string, unknown> {
  const rows = dashboardRows(value, 1);
  return rows.length === 1 && rows[0] ? rows[0] : invalid();
}
function text(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid();
}
export function dashboardProject(value: unknown, ref: string) {
  const row = dashboardRecord(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ref) || row.ref !== ref || !Object.hasOwn(row, "config")) return invalid();
  return {
    ref, db_name: text(row.db_name), db_user: text(row.db_user),
    db_password: text(row.db_password), config: row.config,
  };
}
export function dashboardSize(value: unknown): string {
  const size = text(value);
  return /^(?:0|[1-9]\d*) (?:bytes|kB|MB|GB|TB|PB)$/.test(size) ? size : invalid();
}
export function dashboardRatio(value: unknown): number | null {
  if (value === null) return null;
  const parsed = typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : invalid();
}
export function dashboardUsers(value: unknown) {
  const ids = new Set<string>();
  return dashboardRows(value).map(row => {
    const id = text(row.id);
    const email = row.email === null ? null : typeof row.email === "string" ? row.email : invalid();
    const date = row.created_at instanceof Date ? row.created_at : invalid();
    if (ids.has(id) || !Number.isFinite(date.getTime())) return invalid();
    ids.add(id);
    return { id, email, created_at: date.toISOString() };
  });
}
export function dashboardQueries(value: unknown) {
  const ids = new Set<number>();
  return dashboardRows(value).map(row => {
    const pid = statisticsCount(row.pid);
    if (pid === 0 || ids.has(pid) || row.state !== "active" || typeof row.query !== "string") return invalid();
    ids.add(pid);
    return { pid, usename: row.usename === null ? null : text(row.usename), state: "active", query: row.query };
  });
}
export function dashboardFunctionCount(value: unknown): number {
  if (!Array.isArray(value)) return invalid();
  const names = value.map(text);
  if (new Set(names).size !== names.length) return invalid();
  return names.length;
}

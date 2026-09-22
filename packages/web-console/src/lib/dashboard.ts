import { parseProjectList, type ProjectListItem } from "./project-list";
import { requestValidatedJson } from "./validated-json";

export type DashboardResource<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error" };
export interface DashboardProject extends ProjectListItem { created_at: string }
export interface DashboardSystemInfo {
  cpu: string;
  memory: string;
  uptime: string;
  version: string;
}
function invalid(): never { throw new Error("Invalid dashboard response"); }
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : invalid();
}
export function parseDashboardProjects(value: unknown): DashboardProject[] {
  if (!Array.isArray(value)) return invalid();
  return parseProjectList(value).map((project, index) => {
    const row = record(value[index]);
    const created_at = row.created_at;
    if (typeof created_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(created_at)
      || new Date(created_at).toISOString() !== created_at) return invalid();
    return { ...project, created_at };
  }).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export function parseDashboardSystemInfo(value: unknown): DashboardSystemInfo {
  const row = record(value);
  const { cpu, memory, uptime, version } = row;
  if (typeof cpu !== "string" || !/^(?:100\.0|[1-9]?\d\.\d)%$/.test(cpu)) return invalid();
  if (typeof memory !== "string") return invalid();
  const memoryParts = /^(0|[1-9]\d*) \/ (0|[1-9]\d*) MB$/.exec(memory);
  if (!memoryParts) return invalid();
  const used = Number(memoryParts[1]);
  const total = Number(memoryParts[2]);
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(total) || used > total) return invalid();
  if (typeof uptime !== "string") return invalid();
  const duration = /^(?:(\d+)d )?(?:(\d+)h )?(\d+)m$/.exec(uptime);
  if (!duration) return invalid();
  const days = Number(duration[1] ?? 0);
  const hours = Number(duration[2] ?? 0);
  const minutes = Number(duration[3]);
  if (hours > 23 || minutes > 59
    || !Number.isSafeInteger(days * 86400 + hours * 3600 + minutes * 60)) return invalid();
  const canonical = days > 0 ? `${days}d ${hours}h ${minutes}m`
    : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  if (uptime !== canonical) return invalid();
  if (typeof version !== "string" || version.length > 256 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return invalid();
  return { cpu, memory, uptime, version };
}

export function loadDashboardProjects(
  request: (url: string, options: RequestInit) => Promise<Response>, signal: AbortSignal,
): Promise<DashboardProject[]> {
  return requestValidatedJson("/v1/projects", request, parseDashboardProjects,
    { signal, cache: "no-store" }, { maxBytes: 1024 * 1024 });
}
export function loadDashboardSystemInfo(
  request: (url: string, options: RequestInit) => Promise<Response>, signal: AbortSignal,
): Promise<DashboardSystemInfo> {
  return requestValidatedJson("/v1/system/info", request, parseDashboardSystemInfo,
    { signal, cache: "no-store" }, { maxBytes: 64 * 1024 });
}

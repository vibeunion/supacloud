import { requestValidatedJson } from "./validated-json";

export interface ProjectListItem {
  id: string;
  ref: string;
  name: string;
  region: string;
  status: "ACTIVE_HEALTHY" | "INACTIVE" | "COMING_UP";
}
function invalid(): never { throw new Error("Invalid project list response"); }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : invalid();
}
function text(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid();
}
export function parseProjectList(value: unknown): ProjectListItem[] {
  if (!Array.isArray(value)) return invalid();
  const refs = new Set<string>();
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    const row = record(item);
    const ref = text(row.ref);
    const id = text(row.id);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(ref) || refs.has(ref) || ids.has(id)) return invalid();
    refs.add(ref);
    ids.add(id);
    const status = row.status;
    if (status !== "ACTIVE_HEALTHY" && status !== "INACTIVE" && status !== "COMING_UP") return invalid();
    return { id, ref, name: text(row.name), region: text(row.region), status };
  });
}
export function loadProjectList(
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<ProjectListItem[]> {
  return requestValidatedJson("/v1/projects", request, parseProjectList,
    { signal, cache: "no-store" }, { maxBytes: 1024 * 1024 });
}

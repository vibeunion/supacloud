import { isRecord } from "../utils/project-config";

export interface PublicProjectListItem {
  id: string;
  ref: string;
  organization_id: string;
  organization_slug: string;
  name: string;
  region: string;
  created_at: string;
  status: "ACTIVE_HEALTHY" | "INACTIVE" | "COMING_UP";
}
function invalid(): never { throw new Error("Invalid project list data"); }
function text(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid();
}
function timestamp(value: unknown): string {
  const result = value instanceof Date ? value.toISOString() : value;
  if (typeof result !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)) return invalid();
  return new Date(result).toISOString() === result ? result : invalid();
}
function projectStatus(value: unknown): PublicProjectListItem["status"] {
  if (value === "active") return "ACTIVE_HEALTHY";
  if (value === "paused" || value === "deleted") return "INACTIVE";
  if (value === "creating") return "COMING_UP";
  return invalid();
}

export function publicProjectList(value: unknown): PublicProjectListItem[] {
  if (!Array.isArray(value)) return invalid();
  const refs = new Set<string>();
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!isRecord(item)) return invalid();
    const row = Object.fromEntries(Object.entries(item));
    const ref = text(row.ref);
    const id = text(row.id);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(ref) || refs.has(ref) || ids.has(id)) return invalid();
    refs.add(ref);
    ids.add(id);
    const organizationId = text(row.organization_id);
    return {
      id, ref, organization_id: organizationId,
      organization_slug: Object.hasOwn(row, "organization_slug") ? text(row.organization_slug) : organizationId,
      name: text(row.name), region: text(row.region),
      created_at: timestamp(row.created_at), status: projectStatus(row.status),
    };
  });
}

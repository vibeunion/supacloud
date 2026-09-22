import type { TenantContext } from "@svadmin/core";
import { buildTableRowsResource, isTableIdentifier, parseTableColumnsResponse, tableColumnsEndpoint } from "./resources";
import { requestValidatedJson } from "../validated-json";

export interface TableRowsIdentity {
  projectRef: string;
  schema: string;
  tableName: string;
}
export function matchingTableTenant(tenant: TenantContext | undefined, identity: TableRowsIdentity): TenantContext | null {
  return tenant?.tenantId === identity.projectRef && /^[A-Za-z0-9_-]{1,128}$/.test(identity.projectRef)
    && isTableIdentifier(identity.schema) && isTableIdentifier(identity.tableName) ? tenant : null;
}
export function loadTableRowsResource(
  identity: TableRowsIdentity,
  tenant: TenantContext | undefined,
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal: AbortSignal,
) {
  const target = { ...identity };
  if (!matchingTableTenant(tenant, target)) throw new Error("Project context unavailable");
  return requestValidatedJson(
    tableColumnsEndpoint(target.projectRef, target.schema, target.tableName),
    request, payload => buildTableRowsResource({ ...target, columns: parseTableColumnsResponse(payload) }), { signal },
  );
}
export function formatTableValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value !== null && typeof value === "object") {
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized === "string") return serialized;
    } catch { /* Unsupported objects must not crash the whole table. */ }
  }
  return "[Unsupported value]";
}

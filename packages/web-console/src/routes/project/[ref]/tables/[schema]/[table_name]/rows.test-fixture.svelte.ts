import type { ApiRequestInit } from "../../../../../../lib/api";

export const page = $state({ params: { ref: "a", schema: "public", table_name: "users" } });
export const fixture = $state({ tenant: { tenantId: "a" } });
export const columns = [
  {
    column_name: "id", data_type: "text", udt_name: "text", is_nullable: "NO",
    column_default: null, is_primary_key: true, primary_key_position: 1,
  },
  {
    column_name: "payload", data_type: "jsonb", udt_name: "jsonb", is_nullable: "YES",
    column_default: null, is_primary_key: false, primary_key_position: null,
  },
];
export function apiClient(url: string, options: ApiRequestInit = {}): Promise<Response> {
  return fetch(new URL(url, window.location.origin), options);
}
export function resolve(path: string, params: { ref: string }): string {
  return path.replace("[ref]", encodeURIComponent(params.ref));
}

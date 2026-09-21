import { t } from "elysia";
import type { Static } from "@sinclair/typebox";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_MAX_REQUEST_BYTES = 128 * 1024;
export const MCP_REQUEST_TIMEOUT_MS = 5_000;
export const projectRefSchema = t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" });
export const requestIdSchema = t.Union([
  t.String({ maxLength: 256 }),
  t.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
]);
export const scopeSchema = t.Union([
  t.Object({ role: t.Literal("admin") }, { additionalProperties: false }),
  t.Object({ role: t.Literal("project"), ref: projectRefSchema }, { additionalProperties: false }),
]);
export type McpScope = Static<typeof scopeSchema>;

export const requestSchema = t.Object({
  jsonrpc: t.Literal("2.0"),
  id: t.Optional(requestIdSchema),
  method: t.String({ minLength: 1, maxLength: 256 }),
  params: t.Optional(t.Record(t.String(), t.Unknown())),
}, { additionalProperties: false });
export type JsonRpcRequest = Static<typeof requestSchema>;

export const clientResponseSchema = t.Union([
  t.Object({
    jsonrpc: t.Literal("2.0"), id: requestIdSchema, result: t.Unknown(),
  }, { additionalProperties: false }),
  t.Object({
    jsonrpc: t.Literal("2.0"), id: t.Union([requestIdSchema, t.Null()]),
    error: t.Object({
      code: t.Integer(), message: t.String(), data: t.Optional(t.Unknown()),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

export type JsonRpcId = Static<typeof requestIdSchema> | null;
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

export const tools = [
  {
    name: "supacloud.get_capabilities",
    description: "Read the stateless SupaCloud AI operations contract.",
    inputSchema: t.Object({}, { additionalProperties: false }),
  },
  {
    name: "supacloud.get_backup_readiness",
    description: "Read Pigsty/pgBackRest backup readiness for one project.",
    inputSchema: t.Object({
      project_ref: t.Optional(projectRefSchema),
    }, { additionalProperties: false }),
  },
  {
    name: "supacloud.get_request_metrics",
    description: "Read platform-wide Management API Prometheus metrics (admin only).",
    inputSchema: t.Object({}, { additionalProperties: false }),
  },
  {
    name: "supacloud.plan_pitr_restore",
    description: "Create a non-executing, approval-bound PITR restore plan.",
    inputSchema: t.Object({
      project_ref: t.Optional(projectRefSchema),
      target: t.String({
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?Z$",
        description: "Calendar-valid UTC timestamp, without leap seconds.",
      }),
    }, { additionalProperties: false }),
  },
];

export function scopedTools(scope: McpScope) {
  return tools.filter((tool) => scope.role === "admin" || tool.name !== "supacloud.get_request_metrics");
}

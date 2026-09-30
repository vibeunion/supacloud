import { Elysia, status } from "elysia";
import {
  getPgBackRestStanza,
  isPitrEnabled,
  listBackups,
} from "../services/backup.service";
import {
  renderRequestMetrics,
} from "../utils/observability";
import { ApplicationReleaseStorage } from "../services/application-release-storage";
import { ApplicationDevelopmentError, extractApplicationDevelopment } from "../services/application-development.service";
import {
  requireAdminAuth,
  requireProjectOrAdminAuth,
} from "../middleware/auth";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "supacloud-management";
const SERVER_VERSION = "0.1.0";

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type McpScope = { role: "admin" | "project"; ref?: string };
type McpSurface = "operations" | "developer";

const OPERATIONS_TOOLS = [
  "supacloud.get_capabilities",
  "supacloud.get_backup_readiness",
  "supacloud.get_request_metrics",
  "supacloud.plan_pitr_restore",
] as const;
const DEVELOPER_TOOLS = [
  "supacloud.get_capabilities",
  "supacloud.get_application_development",
] as const;

function rpcResult(id: JsonRpcId | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function textContent(text: string): { type: "text"; text: string }[] {
  return [{ type: "text", text }];
}

function scopedRef(scope: McpScope, params: Record<string, unknown>): string | null {
  if (scope.ref) return scope.ref;
  return typeof params.project_ref === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(params.project_ref)
    ? params.project_ref
    : null;
}

function requiredIdentifier(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function capabilities(scope: McpScope, surface: McpSurface) {
  const developer = surface === "developer";
  return {
    schema: "supacloud.mcp-capabilities.v1",
    surface,
    transport: {
      type: "streamable-http",
      stateless: true,
      endpoint: developer
        ? `/mcp/developer/projects/${scope.ref}`
        : scope.ref ? `/mcp/projects/${scope.ref}` : "/mcp",
      session: "none",
    },
    scopes: developer ? ["project.read"] : scope.ref ? ["project.read"] : ["platform.read", "project.read"],
    write_policy: developer ? "read_only" : "plan_only",
    tools: [...(developer ? DEVELOPER_TOOLS : OPERATIONS_TOOLS)],
    resources: [
      "supacloud://capabilities",
      ...(developer ? [] : [
        "supacloud://project/{project_ref}/backups",
        "supacloud://project/{project_ref}/metrics",
      ]),
    ],
  };
}

async function callTool(
  name: string,
  params: Record<string, unknown>,
  scope: McpScope,
  surface: McpSurface,
): Promise<Record<string, unknown>> {
  const allowed: readonly string[] = surface === "developer" ? DEVELOPER_TOOLS : OPERATIONS_TOOLS;
  if (!allowed.includes(name)) throw new Error(`Unknown MCP tool: ${name}`);

  if (name === "supacloud.get_capabilities") {
    return { content: textContent(JSON.stringify(capabilities(scope, surface), null, 2)) };
  }

  if (name === "supacloud.get_request_metrics") {
    return { content: textContent(renderRequestMetrics()) };
  }

  if (name === "supacloud.get_backup_readiness") {
    const ref = scopedRef(scope, params);
    if (!ref) throw new Error("project_ref is required for project backup readiness");
    const backups = await listBackups(ref);
    return {
      content: textContent(JSON.stringify({
        schema: "supacloud.backup-readiness.v1",
        provider: "pigsty.pgbackrest",
        stanza: getPgBackRestStanza(),
        pitr_enabled: isPitrEnabled(),
        status: backups.length > 0 ? "ready" : "no_completed_backup",
        completed_backup_count: backups.length,
        latest_completed_backup: backups.at(-1) ?? null,
      }, null, 2)),
    };
  }

  if (name === "supacloud.plan_pitr_restore") {
    const ref = scopedRef(scope, params);
    const target = typeof params.target === "string" ? params.target : "";
    if (!ref) throw new Error("project_ref is required for a PITR plan");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(target)) {
      throw new Error("target must be an RFC3339 UTC timestamp");
    }
    return {
      content: textContent(JSON.stringify({
        schema: "supacloud.ai-operation-plan.v1",
        operation: "physical_pitr_restore",
        project_ref: ref,
        target,
        mode: "plan_only",
        requires: [
          "SUPACLOUD_PITR_ENABLED=true",
          "completed physical backup",
          "admin approval",
          "post-restore component health read-back",
        ],
        execute_endpoint: "/v1/platform/backups/restore",
        confirmation: `RESTORE_CLUSTER:${target}`,
      }, null, 2)),
    };
  }

  if (name === "supacloud.get_application_development") {
    const ref = scopedRef(scope, params);
    if (!ref) throw new Error("project_ref is required for application development context");
    const applicationId = requiredIdentifier(params, "application_id");
    const releaseId = requiredIdentifier(params, "release_id");
    const target = requiredIdentifier(params, "target");
    try {
      const { archive } = await new ApplicationReleaseStorage().readArchive(ref, applicationId, releaseId);
      const development = extractApplicationDevelopment(archive, target);
      return {
        content: textContent(JSON.stringify({
          schema: "supacloud.application-development-result.v1",
          read_only: true,
          ...development,
        }, null, 2)),
      };
    } catch (error) {
      if (error instanceof ApplicationDevelopmentError) throw new Error(error.code);
      throw error;
    }
  }

  throw new Error(`Unknown MCP tool: ${name}`);
}

function resourceContents(uri: string, value: unknown) {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(value, null, 2),
    }],
  };
}

async function readResource(uri: string, scope: McpScope, surface: McpSurface) {
  if (uri === "supacloud://capabilities") {
    return resourceContents(uri, capabilities(scope, surface));
  }
  if (surface === "developer") throw new Error(`Unknown MCP resource: ${uri}`);
  const backupMatch = uri.match(/^supacloud:\/\/project\/([A-Za-z0-9_-]{1,64})\/backups$/);
  if (backupMatch) {
    const ref = scopedRef(scope, { project_ref: backupMatch[1] });
    if (!ref) throw new Error("Project resource is outside the authorized scope");
    return resourceContents(uri, {
      schema: "supacloud.backup-readiness.v1",
      provider: "pigsty.pgbackrest",
      stanza: getPgBackRestStanza(),
      pitr_enabled: isPitrEnabled(),
      backups: await listBackups(ref),
    });
  }
  if (uri.match(/^supacloud:\/\/project\/[A-Za-z0-9_-]{1,64}\/metrics$/)) {
    const ref = uri.split("/")[3];
    if (scope.ref && scope.ref !== ref) throw new Error("Project resource is outside the authorized scope");
    return resourceContents(uri, { project_ref: ref, metrics: renderRequestMetrics() });
  }
  throw new Error(`Unknown MCP resource: ${uri}`);
}

export async function processMessage(message: JsonRpcRequest, scope: McpScope, surface: McpSurface = "operations") {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id, -32600, "Invalid Request");
  }
  const params = message.params ?? {};

  if (message.method === "initialize") {
    return rpcResult(message.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "SupaCloud MCP is stateless. No MCP session is created. Use operation receipts for long-running work.",
    });
  }
  if (message.method === "ping") return rpcResult(message.id, {});
  if (message.method === "notifications/initialized") return null;
  if (message.method === "tools/list") {
    const allowed: readonly string[] = surface === "developer" ? DEVELOPER_TOOLS : OPERATIONS_TOOLS;
    const tools = [
        {
          name: "supacloud.get_capabilities",
          description: "Read the stateless SupaCloud AI operations contract.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          name: "supacloud.get_backup_readiness",
          description: "Read Pigsty/pgBackRest backup readiness for one project.",
          inputSchema: {
            type: "object",
            properties: { project_ref: { type: "string" } },
            additionalProperties: false,
          },
        },
        {
          name: "supacloud.get_request_metrics",
          description: "Read the current Management API Prometheus metrics.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          name: "supacloud.get_application_development",
          description: "Read the read-only application development contract (modules, routes, resources, diagnostics) from one immutable application release target.",
          inputSchema: {
            type: "object",
            properties: {
              project_ref: { type: "string" },
              application_id: { type: "string" },
              release_id: { type: "string" },
              target: { type: "string", description: "Delivery target name" },
            },
            required: ["application_id", "release_id", "target"],
            additionalProperties: false,
          },
        },
        {
          name: "supacloud.plan_pitr_restore",
          description: "Create a non-executing, approval-bound PITR restore plan.",
          inputSchema: {
            type: "object",
            properties: {
              project_ref: { type: "string" },
              target: { type: "string", description: "RFC3339 UTC timestamp" },
            },
            required: ["target"],
            additionalProperties: false,
          },
        },
    ].filter((tool) => allowed.includes(tool.name));
    return rpcResult(message.id, { tools });
  }
  if (message.method === "resources/list") {
    const resources = [{ uri: "supacloud://capabilities", name: "SupaCloud capabilities", mimeType: "application/json" }];
    if (scope.ref && surface !== "developer") {
      resources.push(
        { uri: `supacloud://project/${scope.ref}/backups`, name: "Project backups", mimeType: "application/json" },
        { uri: `supacloud://project/${scope.ref}/metrics`, name: "Project metrics", mimeType: "application/json" },
      );
    }
    return rpcResult(message.id, { resources });
  }
  if (message.method === "resources/read") {
    if (typeof params.uri !== "string") return rpcError(message.id, -32602, "uri is required");
    return rpcResult(message.id, await readResource(params.uri, scope, surface));
  }
  if (message.method === "tools/call") {
    if (typeof params.name !== "string") return rpcError(message.id, -32602, "name is required");
    const result = await callTool(params.name, (params.arguments ?? {}) as Record<string, unknown>, scope, surface);
    return rpcResult(message.id, result);
  }
  return rpcError(message.id, -32601, `Method not found: ${message.method}`);
}

export async function handleMcpRequest(request: Request, scope: McpScope, surface: McpSurface = "operations"): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return Response.json({ error: "MCP Streamable HTTP requires application/json" }, { status: 415 });
  }
  const protocolVersion = request.headers.get("mcp-protocol-version");
  if (protocolVersion && protocolVersion !== MCP_PROTOCOL_VERSION && protocolVersion !== "2025-03-26") {
    return Response.json({ error: "Unsupported MCP protocol version" }, { status: 400 });
  }
  let message: JsonRpcRequest;
  try {
    message = await request.json() as JsonRpcRequest;
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  try {
    const response = await processMessage(message, scope, surface);
    if (response === null) {
      return new Response(null, {
        status: 202,
        headers: {
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "Cache-Control": "no-store",
        },
      });
    }
    return Response.json(response, {
      headers: {
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(rpcError(message.id, -32000, error instanceof Error ? error.message : "MCP request failed"), {
      headers: { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION },
      status: 200,
    });
  }
}

async function authorizeMcp(request: Request, ref?: string) {
  if (ref) return requireProjectOrAdminAuth(request, ref);
  return requireAdminAuth(request);
}

export const mcpRoutes = new Elysia()
  .post("/mcp", async ({ request }) => {
    const authError = await authorizeMcp(request);
    if (authError) return status(authError.status, authError.body);
    return handleMcpRequest(request, { role: "admin" });
  })
  .post("/mcp/projects/:ref", async ({ request, params }) => {
    const authError = await authorizeMcp(request, params.ref);
    if (authError) return status(authError.status, authError.body);
    return handleMcpRequest(request, { role: "project", ref: params.ref });
  })
  .post("/mcp/developer/projects/:ref", async ({ request, params }) => {
    const authError = await authorizeMcp(request, params.ref);
    if (authError) return status(authError.status, authError.body);
    return handleMcpRequest(request, { role: "project", ref: params.ref }, "developer");
  });
